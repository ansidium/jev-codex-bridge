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

export const codexInputItems = body => typeof body?.input === "string"
  ? [{ role: "user", content: body.input }] : body?.input ?? [];

/** Keep the visible task and tool evidence in order, without binary or encrypted data. */
export function codexRoutingContext(body, mode = routingContextMode(), currentRequest) {
  if (mode === "previous") return "";
  const entries = [];
  const input = codexInputItems(body);
  const calls = new Map(input.filter(item => item.call_id && item.name).map(item => [item.call_id, item.name]));
  if (mode === "full" && body.instructions) entries.push({ role: "system", text: body.instructions });
  if (mode === "full" && body.tools?.length) entries.push({ type: "available_tools", tools: body.tools });
  for (const item of input) {
    if (item.type === "additional_tools") {
      if (mode === "full") entries.push({ type: item.type, tools: item.tools });
    } else if (["function_call", "custom_tool_call"].includes(item.type)) {
      entries.push({ type: item.type, name: item.name, call_id: item.call_id, input: item.arguments ?? item.input });
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      entries.push({ type: item.type, name: calls.get(item.call_id), call_id: item.call_id, output: textForRouting(item.output) });
    } else if (item.role || item.type === "reasoning") {
      // Codex puts its runtime instructions in developer/system messages.
      // Repository instructions arrive with user context or file/tool results.
      if (mode === "task" && ["system", "developer"].includes(item.role)) continue;
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

// This only prioritizes source evidence; matching a word does not classify a task.
const IMPORTANT = /\b(?:fail(?:ed|ure)?|fatal|panic|exception|assertion|error|regression|unresolved|must|never|required|constraint|invariant|preserve|blocked)\b|ошибк|неудач|сбой|сохран|огранич|нельзя|обязател/iu;
const OMITTED = "\n[... routing context omitted to fit Jev's input window ...]\n";
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

/** Fit a JSON string without splitting a UTF-8 character. */
function edgeExcerpt(text, budget) {
  const bytes = Buffer.from(text);
  if (jsonBytes(text) <= budget) return text;
  const marker = OMITTED;
  let available = budget - jsonBytes(marker);
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

/** Preserve significant interior lines as well as both ends of a large result. */
export function contextExcerpt(text, budget) {
  if (jsonBytes(text) <= budget) return text;
  const lines = text.split("\n");
  const significant = lines.flatMap((line, index) => IMPORTANT.test(line) ? [index] : []);
  if (lines.length < 3 || !significant.length) return edgeExcerpt(text, budget);
  const chosen = new Map();
  let remaining = budget - 2;
  const add = (index, allowance) => {
    if (chosen.has(index)) return;
    const excerpt = edgeExcerpt(lines[index], Math.max(0, allowance - jsonBytes(OMITTED)));
    if (!excerpt) return;
    chosen.set(index, excerpt);
    remaining -= jsonBytes(excerpt) + jsonBytes(OMITTED);
  };
  add(0, Math.floor(remaining / 4));
  add(lines.length - 1, Math.floor(remaining / 3));
  for (const index of significant.reverse()) add(index, Math.min(remaining, Math.max(256, Math.floor(budget / 4))));
  for (const index of [...chosen.keys()]) {
    if (index > 0) add(index - 1, remaining);
    if (index + 1 < lines.length) add(index + 1, remaining);
  }
  for (let index = lines.length - 1; index >= 0 && remaining > 128; index--) add(index, remaining);
  const result = [...chosen].sort(([a], [b]) => a - b).map(([index, text], i, entries) =>
    `${i && index > entries[i - 1][0] + 1 ? OMITTED : i ? "\n" : ""}${text}`).join("");
  return result && jsonBytes(result) <= budget ? result : edgeExcerpt(text, budget);
}

/** Fit complete message records before falling back to excerpts inside a record. */
export function conversationExcerpt(text, budget) {
  if (jsonBytes(text) <= budget) return text;
  let entries;
  try {
    entries = text.split("\n").map(line => JSON.parse(line));
    if (!entries.every(entry => entry && typeof entry === "object" && !Array.isArray(entry))) throw new Error();
  } catch { return contextExcerpt(text, budget); }
  const marker = JSON.stringify({ type: "routing_omission", note: "Some source records or text were omitted to fit Jev's input window; source_index preserves their original order." });
  let remaining = budget - jsonBytes(marker) - 4;
  const ranked = entries.map((entry, index) => ({ entry, index,
    priority: (["user", "developer", "system"].includes(entry.role) ? 5 : entry.type === "reasoning" ? 4 : 1) +
      (IMPORTANT.test(entry.text ?? entry.output ?? "") ? 3 : 0) + (index === 0 || index === entries.length - 1 ? 2 : 0),
  })).sort((a, b) => b.priority - a.priority || b.index - a.index);
  const counts = new Map();
  for (const { priority } of ranked) counts.set(priority, (counts.get(priority) ?? 0) + 1);
  const chosen = [];
  for (let i = 0; i < ranked.length && remaining > 128; i++) {
    const { entry, index, priority } = ranked[i];
    const field = ["text", "output", "input"].find(key => typeof entry[key] === "string");
    const record = { source_index: index, ...entry };
    const peers = counts.get(priority) - 1;
    counts.set(priority, peers);
    const allowance = Math.floor(remaining / (1 + Math.min(peers, 3)));
    if (jsonBytes(JSON.stringify(record)) > allowance && field) {
      const overhead = jsonBytes(JSON.stringify({ ...record, [field]: "" }));
      let fieldBudget = Math.max(0, allowance - overhead);
      do {
        record[field] = contextExcerpt(entry[field], fieldBudget);
        fieldBudget -= Math.max(1, jsonBytes(JSON.stringify(record)) - allowance);
      } while (record[field] && jsonBytes(JSON.stringify(record)) > allowance && fieldBudget > 0);
      if (!record[field]) continue;
    }
    const line = JSON.stringify(record);
    const cost = jsonBytes(line) + 2;
    if (cost > remaining) continue;
    chosen.push({ index, line });
    remaining -= cost;
  }
  const result = [marker, ...chosen.sort((a, b) => a.index - b.index).map(item => item.line)].join("\n");
  return jsonBytes(result) <= budget ? result : contextExcerpt(text, budget);
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
    fitted[name] = name === "conversation" ? conversationExcerpt(value, allowance) : contextExcerpt(value, allowance);
    remaining -= Buffer.byteLength(JSON.stringify(fitted[name])) + name.length + 4;
  }
  fitted.routing_context = { mode, shortened: true, original_bytes: originalBytes };
  return fitted;
}
