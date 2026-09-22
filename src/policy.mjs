import { THRESHOLDS } from "./config.mjs";

export function decide({ jev, current, profiles, contextTokens = 0, hasPriorModel = true, continuation = false }) {
  const settle = (profile, reason) => ({ profile,
    reason: profile.id === current.id ? `${reason}/no-change` : reason,
    changed: profile.id !== current.id });
  const chosen = profiles.find(profile => profile.id === jev?.choice);
  if (!chosen || !Number.isFinite(jev.confidence) || jev.confidence < 0 || jev.confidence > 1) {
    return settle(current, "jev-unavailable");
  }

  const before = current.benchmark;
  const after = chosen.benchmark;
  const downgrade = before && after ? after.intelligence < before.intelligence
    : chosen.model !== current.model || chosen.effortIndex < current.effortIndex;
  const lowerEffort = chosen.model === current.model && chosen.effortIndex < current.effortIndex;
  if (continuation && (downgrade || lowerEffort)) {
    const progress = jev.assessment?.workStatus;
    const gain = jev.assessment?.reasoningGain;
    if (!(progress?.choice === "complete" && progress.confidence >= THRESHOLDS.minConfidence &&
          gain?.choice === "routine" && gain.confidence >= THRESHOLDS.minConfidence)) {
      return settle(current, "continuation-work-not-complete");
    }
  }
  if ((downgrade || lowerEffort) && jev.assessment?.reasoningGain?.choice === "unknown") {
    return settle(current, "unknown-reasoning-no-downgrade");
  }
  if (hasPriorModel && (downgrade || lowerEffort) && jev.confidence < THRESHOLDS.minConfidence) {
    return settle(current, "low-confidence-no-downgrade");
  }

  // A possible cache rebuild is compared with benchmark task savings. This is
  // an API-equivalent estimate, not a forecast of the user's Codex allowance.
  if (hasPriorModel && (downgrade || lowerEffort) &&
      chosen.rates && current.rates) {
    const rebuild = contextTokens * Math.max(0, chosen.rates.cacheWrite - current.rates.cachedInput) / 1e6;
    if (rebuild > 0 && (!Number.isFinite(before?.costPerTaskUSD) || !Number.isFinite(after?.costPerTaskUSD))) {
      return settle(current, "cache-savings-unmeasured");
    }
    const saving = before?.costPerTaskUSD - after?.costPerTaskUSD;
    if (saving > 0 && rebuild > saving) return settle(current,
      lowerEffort ? "effort-change-not-worth-cache-rebuild" : "downgrade-not-worth-cache-rebuild");
  }
  return settle(chosen, "jev");
}
