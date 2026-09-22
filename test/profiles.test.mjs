import test from "node:test";
import assert from "node:assert/strict";
import { codexProfiles, frontierProfiles, fallbackProfile, PROFILE_DATA } from "../src/profiles.mjs";
import { codexModels } from "../src/codex-proxy.mjs";
import { questionForProfiles } from "../src/config.mjs";

const levels = efforts => efforts.map(effort => ({ effort }));
const catalog = new Map([
  ["jev-router", { slug: "jev-router", supported_reasoning_levels: levels(["low", "medium", "high", "xhigh", "max", "ultra"]) }],
  ["gpt-5.6-luna", { slug: "gpt-5.6-luna", supported_reasoning_levels: levels(["low", "medium", "high", "xhigh", "max"]) }],
  ["gpt-6-astra", { slug: "gpt-6-astra", supported_reasoning_levels: levels(["low", "medium", "high", "xhigh", "max", "ultra"]) }],
]);

test("GPT-6 defaults use their own evidence and catalog effort capabilities", () => {
  assert.deepEqual(codexModels().map(model => model.id),
    ["gpt-6-luna", "gpt-5.6-terra", "gpt-6-sol", "gpt-6-astra"]);
  const models = new Map([
    ["jev-router", catalog.get("jev-router")],
    ["gpt-6-sol", { supported_reasoning_levels: levels(["low", "medium", "high", "xhigh", "max", "ultra"]) }],
    ["gpt-6-luna", { supported_reasoning_levels: levels(["low", "medium", "high", "xhigh", "max"]) }],
  ].map(([slug, info]) => [slug, { slug, ...info }]));
  const profiles = codexProfiles(codexModels(models), models, "ultra");
  assert.equal(profiles.find(p => p.id === "gpt-6-sol@max").benchmark.intelligence, 48);
  assert.equal(profiles.find(p => p.id === "gpt-6-luna@medium").benchmark.intelligence, 29);
  assert(profiles.some(p => p.id === "gpt-6-sol@ultra" && !p.benchmark));
  assert(!profiles.some(p => p.id === "gpt-6-luna@ultra"));
  for (const model of ["gpt-6-sol", "gpt-6-luna"]) {
    const low = profiles.find(p => p.id === `${model}@low`);
    assert.equal(low.benchmark.costPerTaskUSD, undefined);
    assert.equal(low.reasoningFamily, "gpt-6");
    assert.equal(low.rates.input, model === "gpt-6-sol" ? 2 : 0.1);
  }
  const long = codexProfiles(codexModels(models), models, "low", 272001);
  assert.deepEqual(long.map(p => p.rates.output), [15, 0.75]);
});

test("joint candidates respect the user ceiling and each model's actual capabilities", () => {
  const models = codexModels(catalog);
  const low = codexProfiles(models, catalog, "low");
  assert.deepEqual(low.map(p => p.id), ["gpt-5.6-luna@low", "gpt-6-astra@low"]);
  const all = codexProfiles(models, catalog, "ultra");
  assert(all.some(p => p.id === "gpt-5.6-luna@max"));
  assert(!all.some(p => p.id === "gpt-5.6-luna@ultra"));
  assert(all.some(p => p.id === "gpt-6-astra@ultra" && !p.benchmark));
  assert(!codexProfiles(models, catalog, "max").some(p => p.effort === "ultra"));
  assert.equal(fallbackProfile(all, "gpt-5.6-luna", "low").effort, "low");
  assert.equal(fallbackProfile(all, "gpt-5.6-luna", "ultra").effort, "max");
});

test("unfamiliar models and effort names use the catalog without inherited benchmark claims", () => {
  const info = { slug: "future-model", description: "The best model ever", context_window: 123456,
    supported_reasoning_levels: levels(["shallow", "deep"]), default_reasoning_level: "deep" };
  const models = new Map([[info.slug, info]]);
  const profiles = codexProfiles(codexModels(models), models, "shallow");
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, "future-model@shallow");
  assert.equal(profiles[0].benchmark, undefined);
  assert.equal(profiles[0].rates, undefined);
  const question = questionForProfiles(profiles);
  assert.equal(question.criteria[profiles[0].id].context_window, 123456);
  assert(!JSON.stringify(question).includes(info.description));
});

test("frontier is advisory: ties, unmeasured efforts and specialized choices remain eligible", () => {
  const profiles = codexProfiles(codexModels(), new Map(), "max");
  const frontier = frontierProfiles(profiles);
  assert(profiles.some(p => p.model === "gpt-5.6-terra"));
  assert(!frontier.some(p => p.id === "gpt-5.6-terra@max"));
  assert(frontier.some(p => p.id === "gpt-6-astra@max"));
  assert(frontier.some(p => p.id === "gpt-6-astra@xhigh"));
  const unknown = { id: "future@deep" };
  assert(frontierProfiles([...profiles, unknown]).includes(unknown));
  const missingCost = { id: "future@low", benchmark: { intelligence: 100 } };
  assert.deepEqual(frontierProfiles([profiles[0], missingCost]), [profiles[0], missingCost]);
});

test("published observations have provenance and finite nonnegative measurements", () => {
  assert.match(PROFILE_DATA.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(PROFILE_DATA.benchmark.methodology, /^https:\/\//);
  for (const model of Object.values(PROFILE_DATA.models)) {
    assert.match(model.source, /^https:\/\//);
    for (const observation of Object.values(model.efforts)) {
      assert(Number.isFinite(observation.intelligence) && observation.intelligence >= 0);
      assert(Number.isFinite(observation.aaBriefcaseElo));
      assert(observation.terminalBench4SuccessRate >= 0 && observation.terminalBench4SuccessRate <= 1);
      if (observation.costPerTaskUSD !== undefined) {
        assert(Number.isFinite(observation.costPerTaskUSD) && observation.costPerTaskUSD > 0);
      }
    }
  }
});

test("token prices follow the measured model's long-context threshold", () => {
  const models = codexModels(catalog);
  const before = codexProfiles(models, catalog, "low", 272000);
  const after = codexProfiles(models, catalog, "low", 272001);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i].rates.input, before[i].rates.input * 2);
    assert.equal(after[i].rates.cachedInput, before[i].rates.cachedInput * 2);
    assert.equal(after[i].rates.cacheWrite, before[i].rates.cacheWrite * 2);
    assert(Math.abs(after[i].rates.output - before[i].rates.output * 1.5) < 1e-9);
    assert.deepEqual(after[i].benchmark, before[i].benchmark);
  }
});
