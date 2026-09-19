import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  COMPLEXITY_MAX_SCORE,
  QUESTIONS,
  questionForProfiles,
  previousRoutingContext,
  THRESHOLDS,
} from "./config.mjs";
import { log } from "./log.mjs";
import { PROFILE_DATA } from "./profiles.mjs";

// The SDK's defaults (10s per attempt, 2 retries, no total budget) are far too slow for a
// per-prompt hot path, so the timeout, retry count and an outer deadline are all pinned.
// Built lazily because the constructor throws when no key is present, and a missing key
// should degrade to "no routing", not stop the session from starting.
let client;
function getClient() {
  client ??= new TypeSafeClient({
    apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY,
    timeout: THRESHOLDS.jevTimeoutMs,
    retry: { maxRetries: THRESHOLDS.jevMaxRetries, backoffInitialMs: 150, backoffMaxMs: 400 },
    logLevel: "warn", // never "debug": request bodies contain the user's prompt
  });
  return client;
}

/**
 * Asks Jev which model-and-effort pair fits this prompt. Returns null on failure, which the policy
 * layer reads as "keep the current model" — routing must never block a prompt.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export async function askJev({ prompt, current, contextTokens, profiles, previousPrompt }) {
  if (!profiles?.length) return null;
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.jevDeadlineMs);
  const previousRequest = previousRoutingContext(previousPrompt);
  const request = {
    state: {
      request: prompt,
      session: { current_model: current.model, current_effort: current.effort,
        reasoning_family: current.reasoningFamily, approximate_context_tokens: contextTokens },
      environment: { available_profiles: profiles.map(profile => profile.id),
        evidence: { as_of: PROFILE_DATA.asOf, benchmark: PROFILE_DATA.benchmark.name,
          cost_unit: PROFILE_DATA.benchmark.costUnit, limitations: PROFILE_DATA.benchmark.limitations } },
      ...(previousRequest ? { previous_request: previousRequest } : {}),
    },
    questions: { ...QUESTIONS, profile: questionForProfiles(profiles) },
  };
  try {
    const result = await getClient().systemOne(request, { signal: abort.signal });
    const { profile: answer, task_complexity, reasoning_required, tool_complexity } = result.answers;
    return {
      ...answer,
      request,
      response: result,
      metrics: {
        taskComplexity: task_complexity.score / COMPLEXITY_MAX_SCORE,
        reasoningRequired: reasoning_required.score / COMPLEXITY_MAX_SCORE,
        toolComplexity: tool_complexity.score / COMPLEXITY_MAX_SCORE,
        contextSize: current.contextWindow ? Math.min(contextTokens / current.contextWindow, 1) : null,
      },
      ms: Date.now() - started,
    };
  } catch (err) {
    log(`routing failed, keeping ${current.id}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
