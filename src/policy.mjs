import { THRESHOLDS, OVERRIDE_PATTERNS } from "./config.mjs";

export function detectOverride(prompt) {
  return OVERRIDE_PATTERNS.find(pattern => pattern.re.test(prompt ?? ""))?.tier ?? null;
}

export function decide({ prompt, jev, current, profiles, contextTokens = 0, hasPriorModel = true }) {
  const settle = (profile, reason) => ({ profile,
    reason: profile.id === current.id ? `${reason}/no-change` : reason,
    changed: profile.id !== current.id });
  const chosen = profiles.find(profile => profile.id === jev?.choice);
  const override = detectOverride(prompt);
  if (override) {
    const matching = profiles.filter(profile => profile.tier === override);
    if (matching.length) return settle(chosen?.tier === override ? chosen
      : matching.find(profile => profile.id === current.id) ?? matching.at(-1), "override");
  }
  if (!chosen) return settle(current, "jev-unavailable");

  const before = current.benchmark;
  const after = chosen.benchmark;
  const downgrade = before && after ? after.intelligence < before.intelligence
    : chosen.model !== current.model || chosen.effortIndex < current.effortIndex;
  if (hasPriorModel && downgrade && jev.confidence < THRESHOLDS.minConfidence) {
    return settle(current, "low-confidence-no-downgrade");
  }

  // A possible cache rebuild is compared with benchmark task savings. This is
  // an API-equivalent estimate, not a forecast of the user's Codex allowance.
  if (hasPriorModel && downgrade && chosen.model !== current.model && before && after &&
      chosen.rates && current.rates) {
    const rebuild = contextTokens * Math.max(0, chosen.rates.cacheWrite - current.rates.cachedInput) / 1e6;
    const saving = before.costPerTaskUSD - after.costPerTaskUSD;
    if (saving > 0 && rebuild > saving) return settle(current, "downgrade-not-worth-cache-rebuild");
  }
  return settle(chosen, "jev");
}
