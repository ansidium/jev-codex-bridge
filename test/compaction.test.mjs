import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { startCodexProxy } from "../src/codex-proxy.mjs";
import { readStatus, STATUS_DIR } from "../src/status.mjs";

test("native compaction preserves the selected model and routing state across restarts", async t => {
  const thread = randomUUID();
  const statusId = `codex-thread-${thread}`;
  t.after(() => { try { unlinkSync(join(STATUS_DIR, `${statusId}.json`)); } catch {} });
  const seen = [];
  const compacted = 'event: response.completed\ndata: ' + JSON.stringify({ type: "response.completed",
    response: { output: [{ type: "compaction", encrypted_content: "opaque-compaction-state" }] },
  }) + '\n\n';
  let reject = false;
  const upstream = http.createServer((req, res) => {
    if (req.url === "/models") return res.end(JSON.stringify({ models: ["gpt-5.6-sol", "gpt-6-astra"].map(slug => ({
      slug, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "high",
    })) }));
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks)), account: req.headers["chatgpt-account-id"] });
      res.writeHead(reject ? 400 : 200, { "content-type": "text/event-stream" });
      res.end(reject ? '{"error":{"message":"compaction rejected"}}' : compacted);
    });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const endpoint = `http://127.0.0.1:${upstream.address().port}`;
  let routeCalls = 0;
  const options = { chatgptBaseURL: endpoint, apiBaseURL: endpoint,
    route: async () => { routeCalls++; return { choice: "gpt-6-astra@low", confidence: 0.99 }; },
  };
  let proxy = await startCodexProxy(options);
  t.after(proxy.close);
  const input = [
    { type: "additional_tools", role: "developer", tools: [] },
    { role: "user", content: "Analyze a distributed transaction failure" },
    { type: "reasoning", encrypted_content: "opaque-reasoning-state" },
  ];
  const send = async (path, body, metadata = {}) => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
      method: "POST", headers: { "content-type": "application/json", "thread-id": thread,
        "chatgpt-account-id": "synthetic-account", ...(metadata ? { "x-codex-turn-metadata": JSON.stringify(metadata) } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  };
  await send("/responses", { model: "jev-router", input, reasoning: { effort: "high" } });
  assert.equal(seen.at(-1).body.model, "gpt-6-astra");
  const decision = readStatus(statusId);
  assert.equal(decision.reasoningEffort, "low");
  const body = { model: "jev-router", input, instructions: "Retain exact evidence", reasoning: { effort: "high" } };
  const metadata = { request_kind: "compaction" };
  for (const metadataInBody of [false, true]) {
    const payload = metadataInBody ? { ...body, client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) } } : body;
    const result = await send("/responses?client_version=test", payload, metadataInBody ? null : metadata);
    assert.deepEqual(result, { status: 200, text: compacted });
    assert.deepEqual(seen.at(-1), { path: "/responses?client_version=test",
      body: { ...payload, model: "gpt-6-astra", reasoning: { effort: "low" } }, account: "synthetic-account" });
    assert.deepEqual(readStatus(statusId), decision);
    proxy.close();
    proxy = await startCodexProxy(options);
    t.after(proxy.close);
  }
  reject = true;
  assert.equal((await send("/responses", body, metadata)).status, 400);
  assert.deepEqual(readStatus(statusId), decision);
  reject = false;
  await send("/responses", { model: "jev-router", reasoning: { effort: "high" },
    input: [...input, { type: "function_call_output", call_id: "1", output: "done" }] });
  assert.equal(seen.at(-1).body.model, "gpt-6-astra");
  assert.equal(seen.at(-1).body.reasoning.effort, "low");
  assert.equal(routeCalls, 1);
  assert.deepEqual(readStatus(statusId), decision);

  await send("/responses", { ...body, model: "gpt-5.6-sol" }, metadata);
  assert.deepEqual(seen.at(-1).body, { ...body, model: "gpt-5.6-sol" });
  assert.deepEqual(readStatus(statusId), decision);
});

test("compaction before any routed turn resolves the alias without classifying or recording a turn", async t => {
  const thread = randomUUID();
  let model;
  const upstream = http.createServer((req, res) => {
    if (req.url === "/models") return res.end(JSON.stringify({ models: [{ slug: "gpt-catalog-model" }] }));
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => { model = JSON.parse(Buffer.concat(chunks)).model; res.end("{}"); });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const endpoint = `http://127.0.0.1:${upstream.address().port}`;
  let routeCalls = 0;
  const proxy = await startCodexProxy({ chatgptBaseURL: endpoint, apiBaseURL: endpoint,
    route: async () => { routeCalls++; return null; } });
  t.after(proxy.close);
  const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, {
    method: "POST", headers: { "content-type": "application/json", "thread-id": thread,
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }) },
    body: JSON.stringify({ model: "jev-router", input: [] }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "{}");
  assert.equal(model, "gpt-catalog-model");
  assert.equal(routeCalls, 0);
  assert.equal(readStatus(`codex-thread-${thread}`), null);
});
