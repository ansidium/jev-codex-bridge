// Every routing decision knob lives here, so the whole policy is reviewable in one file.
import { choice, score } from "@typesafe-ai/sdk";

/**
 * Legacy Jev policy tier names, cheapest first. Concrete Codex model identifiers and
 * reasoning capabilities are supplied by the account catalog in codex-proxy.mjs.
 */
export const TIERS = [
  { name: "haiku" },
  { name: "sonnet" },
  { name: "opus" },
  { name: "fable" },
];

export const TIER_NAMES = TIERS.map((t) => t.name);

/** Enable all account-visible Codex tiers unless the strongest tier is explicitly disabled. */
export const availableTiers = () =>
  TIER_NAMES.filter((n) => n !== "fable" || process.env.JEV_ALLOW_FABLE !== "0");

export const THRESHOLDS = {
  /** An uncertain answer cannot lower an established capability level. */
  minConfidence: 0.3,
  /**
   * Per-attempt Jev HTTP timeout and the hard wall-clock deadline for the whole routing
   * call. Measured: ~300-350ms warm, ~900-1000ms on the first call (TLS handshake), so the
   * deadline leaves room for one retry after a cold-start timeout.
   */
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
};

/** Keep the task's opening and closing constraints when routing a short follow-up. */
export function previousRoutingContext(prompt, budget = Number(process.env.JEV_PREVIOUS_CONTEXT_CHARS ?? 8000)) {
  if (!prompt || budget === 0) return undefined;
  if (!Number.isSafeInteger(budget) || budget < 256 || budget > 32000) {
    throw new Error("JEV_PREVIOUS_CONTEXT_CHARS must be 0 or an integer from 256 to 32000.");
  }
  if (prompt.length <= budget) return prompt;
  const marker = "\n[... previous request shortened ...]\n";
  const head = Math.ceil((budget - marker.length) / 2);
  const tail = budget - marker.length - head;
  return prompt.slice(0, head) + marker + prompt.slice(-tail);
}

const COMPLEXITY_SCALE = [
  "None",
  "Very low",
  "Low",
  "Some",
  "Moderate",
  "Moderate to high",
  "High",
  "Very high",
  "Severe",
  "Extreme",
];

export const COMPLEXITY_MAX_SCORE = COMPLEXITY_SCALE.length - 1;

/** Phrases that mean "the human already decided", checked against the raw prompt. */
export const OVERRIDE_PATTERNS = TIERS.map((t) => ({
  tier: t.name,
  re: new RegExp(
    `\\b(?:use|switch to|with|on)\\s+(?:${{
      haiku: "haiku|fast|luna",
      sonnet: "sonnet|balanced|terra",
      opus: "opus|strong|sol",
      fable: "fable|long|astra",
    }[t.name]})\\b`,
    "i",
  ),
}));

export const QUESTIONS = {
  task_complexity: score(
    "How complex is the task overall, including ambiguity, scope, and consequences of errors?",
    COMPLEXITY_SCALE,
  ),
  reasoning_required: score(
    "How much reasoning is required to complete the request correctly in one pass?",
    COMPLEXITY_SCALE,
  ),
  tool_complexity: score(
    "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
    COMPLEXITY_SCALE,
  ),
};

/** Choose one model-and-effort pair. Quality is a constraint, cost is secondary. */
export const questionForProfiles = (profiles) =>
  choice(
    [
      "Select the model-and-reasoning pair that can complete the entire task correctly and reliably in one pass. Never sacrifice required quality to reduce cost.",
      "First assess ambiguity, depth, tools, consequences of error, and task-specific capability. Only among sufficiently capable pairs prefer lower total completion cost, including input, cached input, reasoning, answer tokens, tools, and retries.",
      "For unresolved failures, formal guarantees, or work where adequacy is uncertain, prioritize stronger measured capability. A low price does not establish that a pair is adequate. Higher Intelligence Index scores mean stronger aggregate measured performance, not a percentage of tasks solved.",
      "Benchmark scores and costs are aggregate evidence, not task-specific guarantees or success probabilities. A dominated pair may still fit a specialized task. Missing measurements do not mean low capability or zero cost.",
      "Compare complete pairs: stronger models at low effort may be more efficient than weaker models at high effort. Small models at high effort can handle substantive work. Use low effort for straightforward tasks; reserve deeper reasoning for work that needs it.",
      "Treat previous_request as context for short approvals or follow-ups. Judge the underlying work, not reply length. Ultra includes automatic delegation; use it when coordinated parallel work benefits the task.",
      "Preserve capability for unfinished work. When changing reasoning families, incompatible reasoning is not carried over, although conversation text remains. Do not switch families for a small saving during an unresolved task that depends on prior reasoning.",
    ],
    Object.fromEntries(
      profiles.map(({ id, model, effort, contextWindow, reasoningFamily, benchmark, rates, onFrontier }) => [
        id,
        { model, effort: effort ?? "Model default", context_window: contextWindow, reasoning_family: reasoningFamily,
          ...(benchmark ? { benchmark, on_price_quality_frontier: onFrontier } : { benchmark: "Not measured" }),
          ...(rates ? { usd_per_million_tokens: rates } : {}) },
      ]),
    ),
  );
