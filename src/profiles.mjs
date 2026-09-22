import { readFileSync } from "node:fs";

export const PROFILE_DATA = JSON.parse(readFileSync(new URL("../data/model-profiles.json", import.meta.url), "utf8"));
export const profileKey = (model, effort) => `${model}@${effort ?? "default"}`;

/** Catalog capabilities and the user's ceiling decide which pairs can run. */
export function codexProfiles(models, catalog, ceiling, contextTokens = 0, data = PROFILE_DATA) {
  const picker = catalog.get("jev-router");
  const pickerOrder = picker?.supported_reasoning_levels?.map(level => level.effort);
  return models.flatMap(model => {
    const info = catalog.get(model.id);
    const evidence = data.models[model.id];
    const levels = info?.supported_reasoning_levels?.length ? info.supported_reasoning_levels
      : evidence ? Object.keys(evidence.efforts).map(effort => ({ effort }))
        : [{ effort: ceiling ?? info?.default_reasoning_level }];
    const order = pickerOrder?.length ? pickerOrder
      : info?.supported_reasoning_levels?.length ? levels.map(level => level.effort) : data.fallbackEffortOrder;
    const cap = ceiling ?? picker?.default_reasoning_level ?? info?.default_reasoning_level;
    const limit = cap ? order.indexOf(cap) : order.length - 1;
    return levels.filter(level => !cap || (order.includes(level.effort) && order.indexOf(level.effort) <= limit))
      .map(level => ({
        id: profileKey(model.id, level.effort), model: model.id, tier: model.tier,
        effort: level.effort, effortIndex: levels.indexOf(level),
        contextWindow: info?.context_window, reasoningFamily: evidence?.reasoningFamily,
        benchmark: evidence?.efforts[level.effort],
        rates: contextTokens > evidence?.longContext?.aboveInputTokens ? evidence.longContext.rates : evidence?.rates,
      }));
  });
}

/** Keep unmeasured pairs and ties: rounded equal scores do not establish dominance. */
export function frontierProfiles(profiles) {
  return profiles.filter(profile => !profile.benchmark || !profiles.some(other =>
    Number.isFinite(profile.benchmark.costPerTaskUSD) && Number.isFinite(other.benchmark?.costPerTaskUSD) &&
    other.benchmark.intelligence > profile.benchmark.intelligence &&
    other.benchmark.costPerTaskUSD <= profile.benchmark.costPerTaskUSD));
}

export function fallbackProfile(profiles, model, effort) {
  const matching = profiles.filter(profile => profile.model === model);
  return matching.find(profile => profile.effort === effort) ?? matching.at(-1) ?? profiles[0];
}
