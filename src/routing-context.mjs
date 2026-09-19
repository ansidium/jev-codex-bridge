import { THRESHOLDS } from "./config.mjs";

export const routingContextMode = () => {
  const mode = process.env.JEV_ROUTING_CONTEXT ?? "task";
  if (!["task", "full", "previous"].includes(mode)) throw new Error("JEV_ROUTING_CONTEXT must be task, full, or previous.");
  return mode;
};

export const textForRouting = value => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(part => {
    if (["text", "input_text", "output_text", "summary_text"].includes(part?.type)) return part.text ?? "";
    if (["input_image", "input_audio", "input_file"].includes(part?.type)) return `[${part.type}: contents unavailable to the text-only router]`;
    return "";
  }).filter(Boolean).join("\n");
};

/** Keep the visible task and tool evidence in order, without binary or encrypted data. */
export function codexRoutingContext(body, mode = routingContextMode(), currentRequest) {
  if (mode === "previous") return "";
  const entries = [];
  if (mode === "full" && body.instructions) entries.push({ role: "system", text: body.instructions });
  if (mode === "full" && body.tools?.length) entries.push({ type: "available_tools", tools: body.tools });
  for (const item of body.input ?? []) {
    if (item.type === "additional_tools") {
      if (mode === "full") entries.push({ type: item.type, tools: item.tools });
    } else if (["function_call", "custom_tool_call"].includes(item.type)) {
      entries.push({ type: item.type, name: item.name, call_id: item.call_id, input: item.arguments ?? item.input });
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      entries.push({ type: item.type, call_id: item.call_id, output: textForRouting(item.output) });
    } else if (item.role || item.type === "reasoning") {
      const text = textForRouting(item.content ?? item.summary)
        .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
        .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, "")
        .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "").trim();
      if (text) entries.push({ role: item.role ?? "assistant", type: item.type ?? "message", text });
    }
  }
  // The current request has its own prioritized field; avoid spending its budget twice.
  const currentIndex = entries.findLastIndex(entry => entry.role === "user" && entry.text === currentRequest);
  if (currentIndex !== -1) entries.splice(currentIndex, 1);
  return entries.map(entry => JSON.stringify(entry)).join("\n");
}

/** Fit a JSON string in UTF-8 bytes, retaining task origins and recent results. */
export function contextExcerpt(text, budget) {
  const bytes = Buffer.from(text);
  if (Buffer.byteLength(JSON.stringify(text)) <= budget) return text;
  const marker = "\n[... routing context omitted to fit Jev's input window ...]\n";
  let available = budget - Buffer.byteLength(JSON.stringify(marker));
  while (available >= 0) {
    let head = Math.ceil(available / 2), tail = bytes.length - Math.floor(available / 2);
    while (head && (bytes[head] & 0xc0) === 0x80) head--;
    while (tail < bytes.length && (bytes[tail] & 0xc0) === 0x80) tail++;
    const result = bytes.subarray(0, head).toString("utf8") + marker + bytes.subarray(tail).toString("utf8");
    const excess = Buffer.byteLength(JSON.stringify(result)) - budget;
    if (excess <= 0) return result;
    available -= excess;
  }
  return "";
}

/** Estimates are not Jev's tokenizer; the API's explicit size error drives further fitting. */
export function routingStateBudget(questions) {
  const longest = Math.max(...Object.values(questions).map(question => Buffer.byteLength(JSON.stringify(question))));
  return Math.max(0, Math.min(THRESHOLDS.jevStateQuestionTokens * 4 - longest,
    THRESHOLDS.jevRequestTokens * 4 - Buffer.byteLength(JSON.stringify(questions))));
}

export function fitRoutingState(state, budget, mode) {
  const { request, previous_request, conversation, ...metadata } = state;
  const originalBytes = Buffer.byteLength(JSON.stringify(state));
  if (originalBytes + 128 <= budget) return { ...state, routing_context: { mode, shortened: false, original_bytes: originalBytes } };
  // Reserve the short current request first. Only oversized requests are excerpted.
  let remaining = Math.max(0, budget - Buffer.byteLength(JSON.stringify(metadata)) - 512);
  const fitted = { ...metadata };
  const fields = Object.entries({ request, previous_request, conversation }).filter(([, value]) => value);
  for (let i = 0; i < fields.length; i++) {
    const [name, value] = fields[i];
    const allowance = i === fields.length - 1 ? remaining : Math.floor(remaining / 2);
    fitted[name] = contextExcerpt(value, allowance);
    remaining -= Buffer.byteLength(JSON.stringify(fitted[name])) + name.length + 4;
  }
  fitted.routing_context = { mode, shortened: true, original_bytes: originalBytes };
  return fitted;
}
