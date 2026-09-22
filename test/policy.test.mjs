import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/policy.mjs";
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
  const specialized = { ...current, benchmark: { ...current.benchmark, aaBriefcaseElo: 1200, terminalBench4SuccessRate: 0.4 } };
  assert.deepEqual(questionForProfiles([specialized]).criteria[current.id].benchmark, specialized.benchmark);
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
  for (const jev of [null, { choice: "unknown@max", confidence: 1 },
    ...[undefined, NaN, Infinity, -1, 1.1].map(confidence => ({ choice: weaker.id, confidence }))]) {
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
  assert.equal(decide({ ...base, current: unmeasured, contextTokens: 900000, jev: choice(weaker) }).profile, unmeasured);
});

test("unpublished task costs cannot justify cache churn or prevent quality upgrades", () => {
  for (const missing of ["before", "after", "both"]) {
    const before = missing === "after" ? current : { ...current, benchmark: { intelligence: 40 } };
    const after = missing === "before" ? weaker : { ...weaker, benchmark: { intelligence: 20 } };
    const params = { current: before, profiles: [before, after], jev: choice(after), contextTokens: 1000 };
    assert.equal(decide(params).profile, before);
    assert.match(decide(params).reason, /cache-savings-unmeasured/);
    assert.equal(decide({ ...params, hasPriorModel: false }).profile, after);
    assert.equal(decide({ ...params, contextTokens: 0 }).profile, after);
    assert.equal(decide({ ...params, current: after, jev: choice(before, 0.1) }).profile, before);
  }
});

test("model names in classifier output cannot bypass policy or veto the selected pair", () => {
  const assessment = { requestedModel: { choice: "small", confidence: 0.99 } };
  const out = decide({ ...base, contextTokens: 900000, jev: { ...choice(weaker, 0.1), assessment } });
  assert.equal(out.profile, current);
  assert.match(out.reason, /low-confidence-no-downgrade/);
  const mismatch = decide({ ...base, jev: { ...choice(stronger), assessment } });
  assert.equal(mismatch.profile, stronger);
  assert.equal(mismatch.reason, "jev");
  const continued = decide({ ...base, continuation: true, jev: { ...choice(weaker), assessment: {
    ...assessment, workStatus: { choice: "reasoning_blocked", confidence: 0.99 },
  } } });
  assert.equal(continued.profile, current);
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

test("continuations can upgrade before failures, and lower only after difficult work is complete", () => {
  const params = { ...base, continuation: true };
  assert.equal(decide({ ...params, jev: choice(stronger, 0.2) }).profile, stronger);
  for (const assessment of [undefined, { workStatus: { choice: "external_blocked", confidence: 0.99 } },
    { workStatus: { choice: "advancing", confidence: 0.99 }, reasoningGain: { choice: "routine", confidence: 0.99 } },
    { workStatus: { choice: "complete", confidence: 0.99 }, reasoningGain: { choice: "deep", confidence: 0.99 } },
    { workStatus: { choice: "complete", confidence: 0.1 }, reasoningGain: { choice: "routine", confidence: 0.99 } }]) {
    assert.equal(decide({ ...params, jev: { ...choice(weaker), assessment } }).profile, current);
  }
  const assessment = { workStatus: { choice: "complete", confidence: 0.99 }, reasoningGain: { choice: "routine", confidence: 0.99 } };
  assert.equal(decide({ ...params, jev: { ...choice(weaker), assessment } }).profile, weaker);
  assert.equal(decide({ ...params, jev: { ...choice(weaker, 0.1), assessment } }).profile, current);
  const expensive = { ...current, rates: { cachedInput: 0, cacheWrite: 5 } };
  const light = { ...weaker, rates: expensive.rates };
  assert.equal(decide({ ...params, current: expensive, profiles: [expensive, light], contextTokens: 1000000,
    jev: { ...choice(light), assessment } }).profile, expensive);
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
