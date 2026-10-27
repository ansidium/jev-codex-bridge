import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startCodexProxy, codexModels } from "../src/codex-proxy.mjs";
import { codexProfiles } from "../src/profiles.mjs";
import { questionForProfiles } from "../src/config.mjs";
import { STATUS_DIR } from "../src/status.mjs";

test("default routing keeps tools and retries free, including after restart; user steering is reassessed", async t => {
  const thread = randomUUID(), bodies = [], calls = [];
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith("/models")) return res.end(JSON.stringify({ models: [{ slug: "gpt-6.1-terra",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] }] }));
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => { bodies.push(JSON.parse(Buffer.concat(chunks))); res.end("ok"); });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const options = { apiBaseURL: base, chatgptBaseURL: base,
    route: async args => { calls.push(args); return { choice: "gpt-6.1-terra@low", confidence: 0.99 }; } };
  let proxy = await startCodexProxy(options);
  t.after(async () => {
    await new Promise(resolve => proxy.close().once("close", resolve));
    await new Promise(resolve => upstream.close(resolve));
    rmSync(join(STATUS_DIR, `codex-thread-${thread}.json`), { force: true });
  });
  let turnId = randomUUID();
  const input = [{ type: "additional_tools", role: "developer", tools: [] }, { role: "user", content: "Inspect the screen." }];
  const send = async (model = "jev-router", requestInput = input) => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST",
      headers: { "content-type": "application/json", "thread-id": thread,
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", turn_id: turnId }) },
      body: JSON.stringify({ model, reasoning: { effort: "max" }, input: requestInput }) });
    assert.equal(response.status, 200); await response.text();
  };
  await send(); await send();
  for (const output of ["Read succeeded", "ERROR: retry required", "Verification passed"]) {
    input.push({ type: "function_call_output", call_id: randomUUID(), output });
    await send();
  }
  assert.equal(calls.length, 1);
  assert.equal(bodies.at(-1).model, "gpt-6.1-terra");
  assert.equal(bodies.at(-1).reasoning.effort, "low");
  await new Promise(resolve => proxy.close().once("close", resolve));
  proxy = await startCodexProxy(options);
  await send();
  assert.equal(calls.length, 1);
  await send("jev-router", [input[0], { role: "user", content: "A compacted summary of the unfinished screen repair." }]);
  assert.equal(calls.length, 1);
  input.push({ role: "user", content: "Now fix the layout." });
  await send();
  assert.equal(calls.length, 2);
  assert.equal(calls.at(-1).prompt, "Now fix the layout.");
  turnId = randomUUID();
  input.push({ role: "user", content: "Now fix the layout." });
  await send();
  assert.equal(calls.length, 3);
  await send("gpt-6.1-sol");
  assert.equal(calls.length, 3);
  assert.equal(bodies.at(-1).model, "gpt-6.1-sol");
});

test("Terra uses its own published measurements, prices and native effort capabilities", () => {
  const slug = "gpt-6.1-terra";
  const catalog = new Map([[slug, { slug, context_window: 1050000,
    supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }, { effort: "ultra" }] }]]);
  const profiles = codexProfiles(codexModels(catalog), catalog, "ultra");
  assert.deepEqual(profiles.map(p => p.effort), ["low", "max", "ultra"]);
  assert.deepEqual(profiles[0].benchmark, { intelligence: 36, costPerTaskUSD: 0.05 });
  assert.deepEqual(profiles[1].benchmark, { intelligence: 48, costPerTaskUSD: 0.4 });
  assert.equal(profiles[2].benchmark, undefined);
  assert.deepEqual(profiles[0].rates, { input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5 });
  assert.deepEqual(codexProfiles(codexModels(catalog), catalog, "max", 272001)[0].rates,
    { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 7.5 });
  assert.equal(questionForProfiles(profiles).criteria[profiles[2].id].benchmark, "Not measured");
  assert.match(questionForProfiles(profiles).criteria[profiles[0].id].strengths, /computer use/);
  const fallback = codexProfiles(codexModels(), new Map(), "max").filter(p => p.model === slug);
  assert.deepEqual(fallback.map(p => p.effort), ["low", "medium", "high", "xhigh", "max"]);
});

test("standalone CLI reuses the managed key file but explicit environment values win", t => {
  const root = mkdtempSync(join(tmpdir(), "jev-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keyFile = join(root, "keys.env");
  writeFileSync(keyFile, "JEV_API_KEY=synthetic-managed-key\nJEV_CODEX_INCLUDE_MODELS=gpt-6.1-terra\n");
  writeFileSync(join(root, "settings.json"), JSON.stringify({ keyFile }));
  mkdirSync(join(root, "user"));
  const script = `import { loadEnv } from ${JSON.stringify(new URL("../src/codex-cli.mjs", import.meta.url).href)};
    loadEnv({ cwd: ${JSON.stringify(root)}, userHome: ${JSON.stringify(join(root, "user"))}, bridgeHome: ${JSON.stringify(root)} });
    console.log(JSON.stringify({ key: process.env.JEV_API_KEY, models: process.env.JEV_CODEX_INCLUDE_MODELS }));`;
  const env = { ...process.env };
  delete env.JEV_API_KEY; delete env.JEV_CODEX_INCLUDE_MODELS;
  for (const explicit of [false, true]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", env: { ...env, ...(explicit ? { JEV_API_KEY: "synthetic-explicit-key" } : {}) } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { key: explicit ? "synthetic-explicit-key" : "synthetic-managed-key", models: "gpt-6.1-terra" });
  }
});
