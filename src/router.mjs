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
import { fitRoutingState, routingContextMode, routingStateBudget } from "./routing-context.mjs";

// Bound total routing time even when the SDK retries or Jev needs a smaller context.
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
export async function askJev({ prompt, current, contextTokens, profiles, previousPrompt, conversation }) {
  if (!profiles?.length) return null;
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.jevDeadlineMs);
  try {
    const mode = routingContextMode();
    const previousRequest = previousRoutingContext(previousPrompt);
    if (mode === "previous") conversation = undefined;
    const previousIncluded = previousRequest && conversation?.includes(JSON.stringify(previousRequest).slice(1, -1));
    const original = {
      state: {
        request: prompt,
        session: { approximate_context_tokens: contextTokens },
        environment: { available_profiles: profiles.map(profile => profile.id),
          evidence: { as_of: PROFILE_DATA.asOf, benchmark: PROFILE_DATA.benchmark.name,
            cost_unit: PROFILE_DATA.benchmark.costUnit, limitations: PROFILE_DATA.benchmark.limitations } },
        ...(previousRequest && !previousIncluded ? { previous_request: previousRequest } : {}),
        ...(conversation ? { conversation } : {}),
      },
      questions: { ...QUESTIONS, profile: questionForProfiles(profiles) },
    };
    let budget = routingStateBudget(original.questions);
    let result, request;
    for (;;) {
      request = { ...original, state: fitRoutingState(original.state, budget, mode) };
      try {
        result = await getClient().systemOne(request, { signal: abort.signal });
        break;
      } catch (error) {
        if (error.status !== 400 || error.body?.detail?.error_type !== "max_tokens_exceeded" ||
            abort.signal.aborted || budget < 1024) throw error;
        budget = Math.floor(budget / 2);
      }
    }
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
