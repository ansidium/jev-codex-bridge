import test from "node:test";
import assert from "node:assert/strict";
import { formatExplanation } from "../src/explain.mjs";

test("formats the last routing decision", () => {
  const output = formatExplanation({
    prompt: "Explain the router architecture",
    tier: "sonnet",
    confidence: 0.94,
    reason: "jev",
    jev: {
      request: { state: { session: { current_model: "haiku", context_tokens: 6200 } } },
      response: { answers: { model_tier: { choice: "sonnet" } } },
    },
    metrics: {
      taskComplexity: 0.82,
      reasoningRequired: 0.91,
      toolComplexity: 0.64,
      contextSize: 0.31,
    },
  });

  assert.match(output, /Task complexity     0\.82/);
  assert.match(output, /Prompt: Explain the router/);
  assert.match(output, /Current tier: HAIKU/);
  assert.match(output, /Context tokens: 6200/);
  assert.match(output, /Recommended tier: SONNET/);
  assert.match(output, /Selected model: SONNET/);
  assert.match(output, /Confidence: 94%/);
  assert.match(output, /Decision: Jev recommendation/);
});

test("shows the concrete provider model when available", () => {
  assert.match(
    formatExplanation({ tier: "haiku", model: "gpt-5.6-luna", confidence: 0.99 }),
    /Selected model: GPT-5\.6-LUNA/,
  );
});

test("shows Jev's exact recommendation separately from the policy's selected model", () => {
  const output = formatExplanation({
    tier: "opus", model: "gpt-5.6-sol", confidence: 0.35,
    reason: "downgrade-not-worth-cache-rebuild/no-change",
    jev: { response: { answers: { model: { choice: "gpt-5.6-luna" } } } },
  });
  assert.match(output, /Recommended model:/);
  assert.match(output, /GPT-5\.6-LUNA/);
  assert.match(output, /Selected model: GPT-5\.6-SOL/);
  assert.doesNotMatch(output, /Recommended tier: OPUS/);
  assert.match(output, /large-context guard/);
});
