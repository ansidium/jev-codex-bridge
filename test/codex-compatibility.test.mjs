import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { codexModels, startCodexProxy } from "../src/codex-proxy.mjs";
import { readStatus, STATUS_DIR } from "../src/status.mjs";

const catalog = [
  { slug: "gpt-standard", use_responses_lite: false },
  { slug: "gpt-lite", use_responses_lite: true },
  { slug: "gpt-hidden", use_responses_lite: true, visibility: "hide" },
];

test("a compression-capable catalog is extended and used for automatic selection", async t => {
  let encoding;
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith("/models")) {
      encoding = req.headers["accept-encoding"];
      const body = JSON.stringify({ models: [{ slug: "gpt-account-only", supported_reasoning_levels: [{ effort: "low" }] }] });
      if (encoding !== "identity") {
        res.writeHead(200, { "content-encoding": "gzip" });
        return res.end(gzipSync(body));
      }
      return res.end(body);
    }
    req.resume(); res.end("ok");
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const endpoint = `http://127.0.0.1:${upstream.address().port}`;
  let selected;
  const proxy = await startCodexProxy({ apiBaseURL: endpoint, chatgptBaseURL: endpoint,
    route: async ({ profiles }) => {
      selected = profiles.map(p => p.id);
      return { choice: profiles[0].id, confidence: 1 };
    } });
  t.after(proxy.close);
  const base = `http://127.0.0.1:${proxy.port}`;
  const response = await fetch(base + "/models?client_version=1.2.3", { headers: { "accept-encoding": "gzip" } });
  const catalog = await response.json();
  assert(catalog.models.some(model => model.slug === "jev-router"));
  assert.equal(encoding, "identity");
  const routed = await fetch(base + "/responses", { method: "POST",
    headers: { "content-type": "application/json", "x-codex-turn-metadata": '{"request_kind":"turn"}' },
    body: JSON.stringify({ model: "jev-router", input: "Perform a small task", reasoning: { effort: "low" } }) });
  await routed.text();
  assert.deepEqual(selected, ["gpt-account-only@low"]);
});

test("cold catalog fetch uses the client version and retries after a failed attempt", async t => {
  const paths = [];
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith("/models")) {
      paths.push(req.url);
      if (paths.length === 1) return res.writeHead(503).end("unavailable");
      return res.end(JSON.stringify({ models: [{ slug: "gpt-account-only", supported_reasoning_levels: [{ effort: "low" }] }] }));
    }
    req.resume(); res.end("ok");
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const endpoint = `http://127.0.0.1:${upstream.address().port}`;
  const choices = [];
  const proxy = await startCodexProxy({ apiBaseURL: endpoint, chatgptBaseURL: endpoint,
    route: async ({ profiles }) => {
      choices.push(profiles.map(p => p.id));
      return { choice: profiles[0].id, confidence: 1 };
    } });
  t.after(proxy.close);
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Codex Desktop/1.2.3-alpha.4 (test)",
        "x-codex-turn-metadata": '{"request_kind":"turn"}' },
      body: JSON.stringify({ model: "jev-router", input: `Task ${i}`, reasoning: { effort: "low" } }) });
    assert.equal(r.status, 200); await r.text();
  }
  assert.deepEqual(paths, ["/models?client_version=1.2.3", "/models?client_version=1.2.3"]);
  assert(choices[0].length > 1);
  assert.deepEqual(choices.slice(1), [["gpt-account-only@low"], ["gpt-account-only@low"]]);
});

test("model eligibility follows catalog capabilities and configured exclusions", t => {
  const previous = process.env.JEV_CODEX_EXCLUDE_MODELS;
  t.after(() => {
    if (previous === undefined) delete process.env.JEV_CODEX_EXCLUDE_MODELS;
    else process.env.JEV_CODEX_EXCLUDE_MODELS = previous;
  });
  delete process.env.JEV_CODEX_EXCLUDE_MODELS;
  const models = new Map(catalog.map(model => [model.slug, model]));
  assert.deepEqual(codexModels(models).map(model => model.id), ["gpt-standard", "gpt-lite"]);
  assert.deepEqual(codexModels(models, true).map(model => model.id), ["gpt-lite"]);
  process.env.JEV_CODEX_EXCLUDE_MODELS = " gpt-standard, gpt-lite ";
  assert.deepEqual(codexModels(models), []);
  assert.deepEqual(codexModels(models, true), []);
  assert(codexModels().some(model => model.id === "gpt-6-sol"));
  process.env.JEV_CODEX_EXCLUDE_MODELS = "gpt-6-sol";
  assert(!codexModels().some(model => model.id === "gpt-6-sol"));
  const generations = new Map(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna"]
    .map(slug => [slug, { slug }]));
  process.env.JEV_CODEX_EXCLUDE_MODELS = "gpt-5.6-luna";
  assert.deepEqual(codexModels(generations).map(model => model.id), ["gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna"]);
});

test("Lite requests use compatible models; rejected requests do not establish routing state", async t => {
  const previous = process.env.JEV_CODEX_EXCLUDE_MODELS;
  process.env.JEV_CODEX_EXCLUDE_MODELS = "gpt-standard";
  t.after(() => {
    if (previous === undefined) delete process.env.JEV_CODEX_EXCLUDE_MODELS;
    else process.env.JEV_CODEX_EXCLUDE_MODELS = previous;
  });
  const thread = randomUUID();
  const statusId = `codex-thread-${thread}`;
  t.after(() => { try { unlinkSync(join(STATUS_DIR, `${statusId}.json`)); } catch {} });
  const seen = [];
  let reject = true;
  let entries = catalog;
  const upstream = http.createServer((req, res) => {
    if (req.url === "/models") return res.end(JSON.stringify({ models: entries }));
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks));
      seen.push({ body, lite: req.headers["x-openai-internal-codex-responses-lite"] });
      res.writeHead(reject ? 400 : 200).end(reject ? "rejected" : "ok");
    });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const previousPrompts = [];
  const endpoint = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = await startCodexProxy({ apiBaseURL: endpoint, chatgptBaseURL: endpoint,
    route: async ({ profiles, previousPrompt }) => {
      assert.deepEqual(profiles.map(profile => profile.model), ["gpt-lite"]);
      previousPrompts.push(previousPrompt);
      return { choice: "gpt-lite@default", confidence: 0.99 };
    },
  });
  t.after(proxy.close);
  const refresh = () => fetch(`http://127.0.0.1:${proxy.port}/models`).then(response => response.text());
  const send = async (prompt, model = "jev-router") => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": thread,
        "x-openai-internal-codex-responses-lite": "true" },
      body: JSON.stringify({ model, input: [
        { type: "additional_tools", role: "developer", tools: [] },
        { role: "user", content: prompt },
      ] }),
    });
    await response.text();
    return response.status;
  };
  await refresh();
  assert.equal(await send("first attempt"), 400);
  assert.equal(readStatus(statusId), null);
  reject = false;
  assert.equal(await send("retry"), 200);
  assert.deepEqual(previousPrompts, [undefined, undefined]);
  assert.equal(seen.at(-1).body.model, "gpt-lite");
  assert.equal(seen.at(-1).lite, "true");
  assert.equal(readStatus(statusId).model, "gpt-lite");
  await send("follow-up");
  assert.equal(previousPrompts.at(-1), "retry");
  await send("manual choice", "gpt-standard");
  assert.equal(seen.at(-1).body.model, "gpt-standard");
  entries = [catalog[0]];
  await refresh();
  const count = seen.length;
  assert.equal(await send("no compatible model"), 503);
  assert.equal(seen.length, count);
});
