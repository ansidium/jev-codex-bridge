import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { codexFailureCheckpoint, startCodexProxy } from "../src/codex-proxy.mjs";
import { readStatus, STATUS_DIR } from "../src/status.mjs";

const failure = (id, output = "FAILED: crash recovery lost committed records") =>
  ({ type: "function_call_output", call_id: id, output });

test("failure checkpoints need new results and recover after history compaction", () => {
  const input = [{ role: "user", content: "Fix recovery" }, failure("a"), failure("b")];
  assert.equal(codexFailureCheckpoint({ input: input.slice(0, -1) }), null);
  assert.deepEqual(codexFailureCheckpoint({ input }), { count: 2, callId: "b" });
  assert.equal(codexFailureCheckpoint({ input }, { count: 2, callId: "b" }), null);
  assert.deepEqual(codexFailureCheckpoint({ input: [...input, failure("b")] }), { count: 2, callId: "b" });
  assert.equal(codexFailureCheckpoint({ input: [...input, failure("c", "All checks passed")] }), null);
  assert.equal(codexFailureCheckpoint({ input: [...input, { role: "user", content: "New task" }, failure("c")] }), null);
  assert.deepEqual(codexFailureCheckpoint({ input }, { count: 8, callId: "compacted-away" }), { count: 2, callId: "b" });
});

test("proxy upgrades a stalled turn, holds external blockers, and restores checkpoints", async t => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.includes("/models")) return res.end(JSON.stringify({ models:
        ["gpt-5.6-sol", "gpt-6-astra"].map(slug => ({ slug, visibility: "list", supported_in_api: true,
          supported_reasoning_levels: ["low", "high", "max"].map(effort => ({ effort })) })) }));
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.setHeader("content-type", "text/event-stream");
      res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"test"}}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"test"}}\n\n');
    });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const threadId = randomUUID(), statusId = `codex-thread-${threadId}`;
  t.after(() => { try { unlinkSync(join(STATUS_DIR, `${statusId}.json`)); } catch {} });
  let calls = 0;
  const route = async () => {
    calls++;
    return { choice: calls === 1 ? "gpt-5.6-sol@high" : calls === 2 ? "gpt-6-astra@high" : "gpt-6-astra@max",
      confidence: 0.95, assessment: { workStatus: {
        choice: calls === 3 ? "external_blocked" : "reasoning_blocked", confidence: 0.95,
      } } };
  };
  const options = { chatgptBaseURL: `http://127.0.0.1:${upstream.address().port}`, route };
  let proxy = await startCodexProxy(options);
  t.after(() => proxy.close());
  const input = [{ type: "additional_tools", role: "developer", tools: [] }, { role: "user", content: "Fix crash recovery" }];
  const send = async (history = input) => fetch(`http://127.0.0.1:${proxy.port}/responses`, {
    method: "POST", headers: { "content-type": "application/json", "thread-id": threadId, "chatgpt-account-id": "test" },
    body: JSON.stringify({ model: "jev-router", reasoning: { effort: "max" }, input: history }),
  }).then(response => response.text());
  await send();
  assert.equal(calls, 1);
  input.push(failure("one"));
  await send();
  assert.equal(calls, 1);
  input.push(failure("two"));
  assert.match(await send(), /gpt-6-astra/);
  assert.equal(calls, 2);
  assert.equal(seen.at(-1).model, "gpt-6-astra");
  assert.equal(readStatus(statusId).trigger, "tool-failures");
  await send();
  assert.equal(calls, 2);
  input.push(failure("three", "Error: vendor service unavailable"), failure("four", "Error: network unavailable"));
  assert.doesNotMatch(await send(), /\[Jev\]/);
  assert.equal(calls, 3);
  assert.equal(seen.at(-1).reasoning.effort, "high");
  assert.match(readStatus(statusId).reason, /continuation-no-reasoning-blocker/);
  await new Promise(resolve => proxy.close().once("close", resolve));
  proxy = await startCodexProxy(options);
  await send();
  assert.equal(calls, 3);
  assert.equal(seen.at(-1).reasoning.effort, "high");
  const compacted = [input[0], input[1], failure("after-compaction-1"), failure("after-compaction-2")];
  await send(compacted);
  assert.equal(calls, 4);
  assert.equal(seen.at(-1).reasoning.effort, "max");
});
