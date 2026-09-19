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

export const rankOf = (name) => TIER_NAMES.indexOf(name);

/** Enable all account-visible Codex tiers unless the strongest tier is explicitly disabled. */
export const availableTiers = () =>
  TIER_NAMES.filter((n) => n !== "fable" || process.env.JEV_ALLOW_FABLE !== "0");

export const THRESHOLDS = {
  /** Below this Jev confidence we refuse to downgrade and cap upgrades at `uncertainCeiling`. */
  minConfidence: 0.3,
  /** Safest tier to land on when Jev is unsure. */
  uncertainCeiling: "sonnet",
  /**
   * Switching models invalidates the prompt cache; the next turn re-sends the whole
   * conversation. Measured at ~23.6k cache-creation tokens switching into Opus, so a
   * downgrade only pays off while the conversation is still small.
   */
  downgradeMaxContextTokens: 20000,
  /**
   * Per-attempt Jev HTTP timeout and the hard wall-clock deadline for the whole routing
   * call. Measured: ~300-350ms warm, ~900-1000ms on the first call (TLS handshake), so the
   * deadline leaves room for one retry after a cold-start timeout.
   */
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
};

export const CONTEXT_WINDOW_TOKENS = 200000;

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
    "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
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

const GUIDANCE = {
  haiku: {
    what: "Trivial, mechanical, or purely factual work.",
    signals: ["Rename, reformat, comment, or run one obvious command"],
    not_for: "Design judgement or multi-file reasoning.",
  },
  sonnet: {
    what: "Ordinary day-to-day engineering with a clear, bounded shape.",
    signals: ["Implement a specified function, test existing behaviour, or fix an understood local bug"],
    not_for: "Open-ended architecture, subtle concurrency, or unknown-cause debugging.",
  },
  opus: {
    what: "Hard reasoning, ambiguity, or high blast radius.",
    signals: ["Unknown-cause debugging, cross-module design, security, auth, concurrency, or migrations"],
    not_for: "Routine work with a clear implementation.",
  },
  fable: {
    what: "Very large or long-running work beyond a normal focused session.",
    signals: ["Whole-repo migration, unusually large context, or multi-hour autonomous execution"],
    not_for: "Anything a strong model can finish in one focused session.",
  },
};

// Codex's workhorse/frontier roles differ from Claude's Opus/Fable roles.
export const CODEX_GUIDANCE = {
  opus: {
    what: "Reliable workhorse for standard engineering and coordinated implementation with a known approach.",
    signals: ["Bounded multi-file changes, implementation of an agreed plan, and routine debugging"],
    not_for: "Open-ended architecture, unknown-cause concurrency failures, security-critical design, or the hardest reasoning.",
  },
  fable: {
    what: "Most capable tier for difficult, ambiguous, or high-risk reasoning, regardless of task length.",
    signals: ["Unknown-cause concurrency bugs, cross-system invariants, security-critical design, difficult proofs, whole-repository migrations"],
    not_for: "Mechanical or well-understood routine implementation.",
  },
};

/** Build a Jev choice from the exact models available to this account and CLI. */
export const questionForModels = (models) =>
  choice(
    [
      "Pick the cheapest exact model that can fully complete this coding request in one pass, without retrying on a stronger model.",
      "Treat different model versions as separate choices. Judge required reasoning, not requested reply length.",
    ],
    Object.fromEntries(
      models.map(({ id, tier, description, guidance }) => [
        id,
        { model: description ?? id, ...(guidance ?? GUIDANCE[tier]) },
      ]),
    ),
  );

/** Use the account catalog's effort levels and descriptions, not a model-name table. */
export const questionForEfforts = (levels) => choice(
  ["Choose the least reasoning effort sufficient to complete this user task reliably on the selected model.",
    "Use previous_request to interpret a short approval or continuation. A short reply can still authorize complex work."],
  Object.fromEntries(levels.map(({ effort, description }) => [effort, description || effort])),
);

/** Whether policy accepted Jev's exact model, including a version change within one tier. */
export const shouldUseExactModel = (reason, chosenTier, finalTier) =>
  (reason === "jev" || reason === "jev/no-change") && chosenTier === finalTier;
