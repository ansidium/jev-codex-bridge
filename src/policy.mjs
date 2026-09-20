import { THRESHOLDS } from "./config.mjs";

export function decide({ jev, current, profiles, contextTokens = 0, hasPriorModel = true, upgradeOnly = false }) {
  const settle = (profile, reason) => ({ profile,
    reason: profile.id === current.id ? `${reason}/no-change` : reason,
    changed: profile.id !== current.id });
  const chosen = profiles.find(profile => profile.id === jev?.choice);
  const requested = jev?.assessment?.requestedModel;
  if (requested?.confidence >= THRESHOLDS.minConfidence && profiles.some(profile => profile.model === requested.choice)) {
    if (chosen?.model !== requested.choice) return settle(current, "requested-model-mismatch");
    if (!upgradeOnly) return settle(chosen, "override");
  }
  if (!chosen) return settle(current, "jev-unavailable");

  const before = current.benchmark;
  const after = chosen.benchmark;
  if (upgradeOnly) {
    const progress = jev.assessment?.workStatus;
    if (progress?.choice !== "reasoning_blocked" || progress.confidence < THRESHOLDS.minConfidence) {
      return settle(current, "continuation-no-reasoning-blocker");
    }
    const upgrade = (before && after && after.intelligence > before.intelligence) ||
      (chosen.model === current.model && chosen.effortIndex > current.effortIndex);
    if (!upgrade) return settle(current, "continuation-no-upgrade");
  }
  const downgrade = before && after ? after.intelligence < before.intelligence
    : chosen.model !== current.model || chosen.effortIndex < current.effortIndex;
  const lowerEffort = chosen.model === current.model && chosen.effortIndex < current.effortIndex;
  if ((downgrade || lowerEffort) && jev.assessment?.reasoningGain?.choice === "unknown") {
    return settle(current, "unknown-reasoning-no-downgrade");
  }
  if (hasPriorModel && (downgrade || lowerEffort) && jev.confidence < THRESHOLDS.minConfidence) {
    return settle(current, "low-confidence-no-downgrade");
  }

  // A possible cache rebuild is compared with benchmark task savings. This is
  // an API-equivalent estimate, not a forecast of the user's Codex allowance.
  if (hasPriorModel && (downgrade || lowerEffort) && before && after &&
      chosen.rates && current.rates) {
    const rebuild = contextTokens * Math.max(0, chosen.rates.cacheWrite - current.rates.cachedInput) / 1e6;
    const saving = before.costPerTaskUSD - after.costPerTaskUSD;
    if (saving > 0 && rebuild > saving) return settle(current,
      lowerEffort ? "effort-change-not-worth-cache-rebuild" : "downgrade-not-worth-cache-rebuild");
  }
  return settle(chosen, "jev");
}
