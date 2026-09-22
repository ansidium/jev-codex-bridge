import { THRESHOLDS } from "./config.mjs";

// Catalog effort order bounds an unmeasured effort without inventing its score.
// Cross-model comparisons remain unknown when the measured bounds overlap.
function capabilityChange(before, after, profiles) {
  if (before.model === after.model) return Math.sign(after.effortIndex - before.effortIndex);
  if (Number.isFinite(before.benchmark?.intelligence) && Number.isFinite(after.benchmark?.intelligence)) {
    return Math.sign(after.benchmark.intelligence - before.benchmark.intelligence);
  }
  const bounds = profile => {
    const measured = profiles.filter(p => p.model === profile.model && Number.isFinite(p.benchmark?.intelligence));
    return [Math.max(-Infinity, ...measured.filter(p => p.effortIndex <= profile.effortIndex).map(p => p.benchmark.intelligence)),
      Math.min(Infinity, ...measured.filter(p => p.effortIndex >= profile.effortIndex).map(p => p.benchmark.intelligence))];
  };
  const [beforeLow, beforeHigh] = bounds(before), [afterLow, afterHigh] = bounds(after);
  if (afterLow > beforeHigh) return 1;
  if (afterHigh < beforeLow) return -1;
  return null;
}

export function decide({ jev, current, profiles, cachedPrefixTokens = 0, hasPriorModel = true, continuation = false }) {
  const settle = (profile, reason) => ({ profile,
    reason: profile.id === current.id ? `${reason}/no-change` : reason,
    changed: profile.id !== current.id });
  const chosen = profiles.find(profile => profile.id === jev?.choice);
  if (!chosen || !Number.isFinite(jev.confidence) || jev.confidence < 0 || jev.confidence > 1) {
    return settle(current, "jev-unavailable");
  }

  const before = current.benchmark;
  const after = chosen.benchmark;
  const change = capabilityChange(current, chosen, [...profiles, current]);
  const lowerEffort = chosen.model === current.model && chosen.effortIndex < current.effortIndex;
  const protect = chosen.id !== current.id && change !== 1;
  if (continuation && protect) {
    const progress = jev.assessment?.workStatus;
    const gain = jev.assessment?.reasoningGain;
    if (!(progress?.choice === "complete" && progress.confidence >= THRESHOLDS.minConfidence &&
          gain?.choice === "routine" && gain.confidence >= THRESHOLDS.minConfidence)) {
      return settle(current, "continuation-work-not-complete");
    }
  }
  if (protect && jev.assessment?.reasoningGain?.choice === "unknown") {
    return settle(current, "unknown-reasoning-no-downgrade");
  }
  if (protect && jev.confidence < THRESHOLDS.minConfidence) {
    return settle(current, "low-confidence-no-downgrade");
  }

  // Only a measured cache read/write on an unchanged prefix establishes reuse.
  // API-equivalent rebuilding cost does not forecast the user's Codex allowance.
  if (hasPriorModel && protect &&
      chosen.rates && current.rates) {
    const rebuild = cachedPrefixTokens * Math.max(0, chosen.rates.cacheWrite - current.rates.cachedInput) / 1e6;
    if (rebuild > 0 && (!Number.isFinite(before?.costPerTaskUSD) || !Number.isFinite(after?.costPerTaskUSD))) {
      return settle(current, "cache-savings-unmeasured");
    }
    const saving = before?.costPerTaskUSD - after?.costPerTaskUSD;
    if (saving > 0 && rebuild > saving) return settle(current,
      lowerEffort ? "effort-change-not-worth-cache-rebuild" : "downgrade-not-worth-cache-rebuild");
  }
  return settle(chosen, "jev");
}
