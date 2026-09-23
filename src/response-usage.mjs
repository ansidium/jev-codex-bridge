import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { codexInputItems } from "./routing-context.mjs";

// Hash the actual model request, retaining cache-affecting fields and opaque
// input. Store only a hash and item count, never another copy of task content.
export function cachePrefix(body, count = codexInputItems(body).length) {
  const { input, client_metadata, stream, store, ...fields } = body;
  return { items: count, hash: createHash("sha256")
    .update(JSON.stringify({ ...fields, input: codexInputItems(body).slice(0, count) })).digest("hex") };
}

function matchesPrefix(body, prefix) {
  return Number.isSafeInteger(prefix?.items) && prefix.items >= 0 &&
    codexInputItems(body).length >= prefix.items && cachePrefix(body, prefix.items).hash === prefix.hash;
}

export function reusableCacheTokens(body, cache) {
  return Number.isSafeInteger(cache?.tokens) && cache.tokens >= 0 && matchesPrefix(body, cache) ? cache.tokens : 0;
}

/** Measured input covers opaque history; only the added content needs estimation. */
export function estimateContext(body, previous) {
  const measured = Number.isSafeInteger(previous?.usage?.inputTokens) && previous.usage.inputTokens >= 0 &&
    matchesPrefix(body, previous.cache);
  const input = codexInputItems(body).slice(measured ? previous.cache.items : 0);
  let unmeasuredContent = false;
  // Ciphertext, media URLs and file payload sizes are not model token counts.
  const visible = JSON.stringify({ ...(measured ? {} : { instructions: body.instructions, tools: body.tools }), input },
    (key, value) => {
      if ((key === "encrypted_content" && value) ||
          ["input_image", "input_audio", "input_file", "compaction"].includes(value?.type)) {
        unmeasuredContent = true;
        return undefined;
      }
      return value;
    });
  return { tokens: (measured ? previous.usage.inputTokens : 0) + (input.length || !measured ? Math.round(visible.length / 4) : 0),
    source: measured ? "usage-prefix" : "text-estimate", unmeasuredContent };
}

export function measuredUsage(usage) {
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  if (!valid(usage?.input_tokens)) return null;
  const fields = { inputTokens: usage.input_tokens, cachedInputTokens: usage.input_tokens_details?.cached_tokens,
    cacheWriteInputTokens: usage.input_tokens_details?.cache_write_tokens, outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens };
  if ([fields.cachedInputTokens, fields.cacheWriteInputTokens].some(value => value != null && !valid(value)) ||
      (fields.cachedInputTokens ?? 0) + (fields.cacheWriteInputTokens ?? 0) > fields.inputTokens) return null;
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => valid(value)));
}

/** Observe successful completions without buffering or changing the SSE stream. */
export function observeUsage(response, complete, streaming = false) {
  if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") return;
  const accept = value => {
    const usage = measuredUsage(value?.usage);
    if (usage && value.status === "completed") complete(usage);
  };
  const contentType = response.headers["content-type"];
  if (contentType?.includes("text/event-stream") || (!contentType && streaming)) {
    const lines = createInterface({ input: response, crlfDelay: Infinity });
    let data = [];
    lines.on("line", line => {
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      else if (!line) {
        try {
          const event = JSON.parse(data.join("\n"));
          if (event.type === "response.completed") accept(event.response);
        } catch { /* Other SSE events, including [DONE], carry no usage. */ }
        data = [];
      }
    });
    lines.once("error", () => lines.close());
  } else if (!contentType || contentType.includes("application/json")) {
    const chunks = [];
    response.on("data", chunk => chunks.push(chunk));
    response.on("end", () => {
      try { accept(JSON.parse(Buffer.concat(chunks).toString())); } catch { /* No usable response. */ }
    });
  }
}
