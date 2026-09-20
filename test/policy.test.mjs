import test from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride } from "../src/policy.mjs";
import { QUESTIONS, questionForProfiles } from "../src/config.mjs";

const current = { id: "small@deep", model: "small", tier: "haiku", effortIndex: 2,
  benchmark: { intelligence: 40, costPerTaskUSD: 0.4 },
  rates: { cachedInput: 0.1, cacheWrite: 1.25 } };
const stronger = { id: "large@low", model: "large", tier: "fable", effortIndex: 0,
  benchmark: { intelligence: 50, costPerTaskUSD: 0.3 },
  rates: { cachedInput: 1, cacheWrite: 12.5 } };
const weaker = { id: "small@low", model: "small", tier: "haiku", effortIndex: 0,
  benchmark: { intelligence: 20, costPerTaskUSD: 0.1 }, rates: current.rates };
const profiles = [current, stronger, weaker];
const base = { prompt: "refactor the parser", current, profiles };
const choice = (profile, confidence = 0.95) => ({ choice: profile.id, confidence });

test("score rubrics contain API-valid descriptions; pair choices contain measured evidence", () => {
  for (const question of Object.values(QUESTIONS)) {
    assert(Object.values(question.criteria).every(description => typeof description === "string"));
    if (question.type === "score") assert(question.criteria.length <= 10);
  }
  const question = questionForProfiles(profiles);
  assert.deepEqual(Object.keys(question.criteria), profiles.map(profile => profile.id));
  assert.equal(question.criteria[current.id].benchmark.intelligence, 40);
});

test("selects the complete pair, including a same-model effort change", () => {
  assert.equal(decide({ ...base, jev: choice(weaker) }).profile, weaker);
  assert.equal(decide({ ...base, jev: choice(stronger) }).profile, stronger);
});

test("an uncertain measured capability upgrade is never capped for cost", () => {
  assert.equal(decide({ ...base, contextTokens: 500000, jev: choice(stronger, 0.2) }).profile, stronger);
});

test("uncertain downgrades preserve the established pair, including effort", () => {
  const out = decide({ ...base, jev: choice(weaker, 0.2) });
  assert.equal(out.profile, current);
  assert.match(out.reason, /low-confidence-no-downgrade/);
});

test("capability is compared by measurements, not model tier order", () => {
  const largeButWeaker = { ...stronger, benchmark: weaker.benchmark };
  const actual = decide({ ...base, profiles: [current, largeButWeaker], jev: choice(largeButWeaker, 0.2) });
  assert.equal(actual.profile, current);
  assert.match(actual.reason, /low-confidence/);
});

test("failure and an invented profile preserve the current pair", () => {
  for (const jev of [null, { choice: "unknown@max", confidence: 1 }]) {
    const out = decide({ ...base, jev });
    assert.equal(out.profile, current);
    assert.equal(out.changed, false);
    assert.match(out.reason, /jev-unavailable/);
  }
});

test("cache guard uses rates and task-cost difference, not a fixed context limit", () => {
  const expensive = { ...stronger, benchmark: { intelligence: 50, costPerTaskUSD: 0.15 } };
  const params = { ...base, current: expensive, profiles: [expensive, weaker], jev: choice(weaker) };
  assert.equal(decide({ ...params, contextTokens: 1000 }).profile, weaker);
  assert.equal(decide({ ...params, contextTokens: 400000 }).profile, expensive);
  assert.equal(decide({ ...params, contextTokens: 400000, hasPriorModel: false }).profile, weaker);
});

test("unknown measurements do not invent cache savings or cap deeper same-model effort", () => {
  const unmeasured = { ...current, id: "small@new-level", effortIndex: 3, benchmark: undefined };
  assert.equal(decide({ ...base, profiles: [current, unmeasured], jev: choice(unmeasured, 0.2) }).profile, unmeasured);
  assert.equal(decide({ ...base, current: unmeasured, contextTokens: 900000, jev: choice(weaker) }).profile, weaker);
});

test("explicit aliases retain the requested model family and Jev's supported effort", () => {
  assert.equal(detectOverride("switch to astra"), "fable");
  assert.equal(detectOverride("the opus of his career"), null);
  const out = decide({ ...base, prompt: "use astra", jev: choice(weaker) });
  assert.equal(out.profile, stronger);
  assert.equal(out.reason, "override");
  assert.equal(detectOverride('Do not use astra. Correct the example string "use astra" in README.'), null);
  assert.equal(detectOverride('Explain why the documentation says "use astra".'), null);
  assert.equal(detectOverride("Please use Astra for this repair."), "fable");
  assert.equal(detectOverride("Используй Astra для исправления."), "fable");
});

test("effort reductions account for cache rebuilding without blocking deeper reasoning", () => {
  const deep = { ...current, benchmark: { intelligence: 40, costPerTaskUSD: 0.4 },
    rates: { cachedInput: 0.4, cacheWrite: 5 } };
  const light = { ...weaker, rates: deep.rates };
  const params = { ...base, current: deep, profiles: [deep, light], jev: choice(light) };
  assert.equal(decide({ ...params, contextTokens: 1000 }).profile, light);
  const held = decide({ ...params, contextTokens: 200000 });
  assert.equal(held.profile, deep);
  assert.match(held.reason, /effort-change-not-worth-cache-rebuild/);
  const up = decide({ ...params, current: light, jev: choice(deep, 0.1), contextTokens: 200000 });
  assert.equal(up.profile, deep);
  const tied = { ...light, benchmark: { ...light.benchmark, intelligence: deep.benchmark.intelligence } };
  assert.equal(decide({ ...params, profiles: [deep, tied], jev: choice(tied), contextTokens: 200000 }).profile, deep);
  assert.equal(decide({ ...params, profiles: [deep, tied], jev: choice(tied, 0.1), contextTokens: 0 }).profile, deep);
});

test("tool checkpoints only upgrade after Jev identifies a reasoning blocker", () => {
  const blocked = { workStatus: { choice: "reasoning_blocked", confidence: 0.9 } };
  const params = { ...base, upgradeOnly: true };
  assert.equal(decide({ ...params, jev: { ...choice(stronger, 0.2), assessment: blocked } }).profile, stronger);
  assert.equal(decide({ ...params, jev: { ...choice(weaker), assessment: blocked } }).profile, current);
  for (const assessment of [undefined, { workStatus: { choice: "external_blocked", confidence: 0.99 } },
    { workStatus: { choice: "reasoning_blocked", confidence: 0.1 } }]) {
    assert.equal(decide({ ...params, jev: { ...choice(stronger), assessment } }).profile, current);
  }
});

test("unknown task evidence cannot justify a downgrade, including a fresh task", () => {
  const assessment = { reasoningGain: { choice: "unknown", confidence: 0.95 } };
  for (const hasPriorModel of [true, false]) {
    const result = decide({ ...base, hasPriorModel, jev: { ...choice(weaker), assessment } });
    assert.equal(result.profile, current);
    assert.match(result.reason, /unknown-reasoning-no-downgrade/);
    assert.equal(decide({ ...base, hasPriorModel, jev: { ...choice(stronger), assessment } }).profile, stronger);
  }
});
