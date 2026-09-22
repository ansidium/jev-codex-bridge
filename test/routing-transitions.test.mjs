import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { startCodexProxy, codexConversationKey } from "../src/codex-proxy.mjs";
import { readStatus, STATUS_DIR } from "../src/status.mjs";

const initial = text => [{ type: "additional_tools", role: "developer", tools: [] }, { role: "user", content: text }];
const result = (id, output) => ({ type: "function_call_output", call_id: id, output });
const answer = (choice, gain = "deep", work = "advancing", confidence = 0.99) => ({ choice, confidence,
  assessment: { reasoningGain: { choice: gain, confidence: 0.99 }, workStatus: { choice: work, confidence: 0.99 } } });

async function fixture(t, route, { cli = false, respond, models = ["gpt-5.6-luna", "gpt-6-astra"] } = {}) {
  const thread = randomUUID(), record = cli ? `codex-test-${thread}` : `codex-thread-${thread}`;
  const calls = [], seen = [], disconnected = [];
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith("/models")) return res.end(JSON.stringify({ models: models.map(slug => ({
      slug, visibility: "list", supported_in_api: true,
      supported_reasoning_levels: ["low", "max"].map(effort => ({ effort })), default_reasoning_level: "max",
    })) }));
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks));
      seen.push(body);
      if (respond) respond(body, res);
      else res.writeHead(200, { "content-type": "text/event-stream" }).end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
    });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${upstream.address().port}`;
  const options = { apiBaseURL: endpoint, chatgptBaseURL: endpoint, statusId: cli ? record : "",
    route: args => { calls.push(args); return route(args); },
    authorize: req => { disconnected.push(new Promise(resolve => req.socket.once("close", resolve))); return true; } };
  let proxy = await startCodexProxy(options);
  t.after(async () => {
    await new Promise(resolve => proxy.close().once("close", resolve));
    await new Promise(resolve => upstream.close(resolve));
    try { unlinkSync(join(STATUS_DIR, `${record}.json`)); } catch {}
  });
  return { thread, calls, seen, disconnected, status: () => readStatus(record),
    restart: async () => { await new Promise(resolve => proxy.close().once("close", resolve)); proxy = await startCodexProxy(options); },
    send: async (input, { turnId, kind = "turn", model = "jev-router", source = "header", signal } = {}) => {
      const metadata = { request_kind: kind, ...(turnId ? { turn_id: turnId } : {}), thread_id: thread };
      const body = { model, reasoning: { effort: "max" }, input,
        ...(source === "body" ? { client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) } } : {}) };
      const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", signal,
        headers: { "content-type": "application/json", ...(source === "none" ? { "thread-id": thread } : {}),
          ...(source === "header" ? { "x-codex-turn-metadata": JSON.stringify(metadata) } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, text: await response.text() };
    } };
}

test("new evidence reassesses steering and successful tools; identical retries preserve decisions across restarts", async t => {
  for (const source of ["header", "body", "none"]) for (const cli of [false, true]) {
    await t.test(`${source}, ${cli ? "CLI" : "Desktop"}`, async t => {
      let next = answer("gpt-5.6-luna@low", "routine", "complete");
      const f = await fixture(t, () => next, { cli });
      const turnId = randomUUID(), options = { turnId, source }, input = initial("Give the observed status.");
      await f.send(input, options);
      assert.equal(f.calls.length, 1);
      await f.send(input, options);
      assert.equal(f.calls.length, 1);
      await f.restart();
      await f.send(input, options);
      assert.equal(f.calls.length, 1);
      next = answer("gpt-6-astra@max");
      input.push({ role: "user", content: "Prove the safety of the concurrent transaction protocol." });
      await f.send(input, options);
      assert.equal(f.calls.length, 2);
      assert.equal(f.seen.at(-1).model, "gpt-6-astra");
      if (source !== "none") assert.equal(f.calls.at(-1).continuation, true);
      next = answer("gpt-5.6-luna@low", "routine", "advancing");
      input.push(result("read", "Read succeeded. The transaction proof is still unfinished."));
      await f.send(input, options);
      assert.equal(f.calls.length, 3);
      assert.equal(f.calls.at(-1).continuation, true);
      assert.equal(f.seen.at(-1).model, "gpt-6-astra");
      assert.match(f.status().reason, /continuation-work-not-complete/);
      next = answer("gpt-5.6-luna@low", "routine", "complete");
      input.push(result("verify", "Proof and implementation verified. Only reporting the established result remains."));
      await f.send(input, options);
      assert.equal(f.seen.at(-1).model, "gpt-5.6-luna");
      assert.equal(f.status().trigger, "context-change");
      await f.restart();
      await f.send(input, options);
      assert.equal(f.calls.length, 4);
    });
  }
});

test("status followed by autonomous repair can upgrade before any tool failure", async t => {
  let next = answer("gpt-6-astra@max");
  const f = await fixture(t, () => next);
  const input = initial("Repair and prove transaction ordering.");
  await f.send(input, { turnId: randomUUID() });
  const statusTurn = randomUUID();
  input.push({ role: "user", content: "Report the current status." });
  next = answer("gpt-5.6-luna@low", "routine", "complete");
  await f.send(input, { turnId: statusTurn });
  assert.equal(f.seen.at(-1).model, "gpt-5.6-luna");
  next = answer("gpt-6-astra@max");
  input.push({ role: "assistant", content: "Status reported; resuming the unresolved proof." },
    result("inspect", "The read succeeded. There are two conflicting leader histories."));
  await f.send(input, { turnId: statusTurn });
  assert.equal(f.seen.at(-1).model, "gpt-6-astra");
  assert.equal(f.calls.at(-1).continuation, true);
  assert.match(f.calls.at(-1).conversation, /conflicting leader histories/);
});

test("explicit turns need no tool schema; summaries and manual models bypass classification", async t => {
  const f = await fixture(t, () => answer("gpt-6-astra@max"));
  await f.send([{ role: "user", content: "Solve the new task." }], { turnId: randomUUID() });
  assert.equal(f.calls.length, 1);
  const decision = f.status();
  for (const kind of ["summary", "compaction"]) {
    await f.send(initial("Summarize the task."), { turnId: randomUUID(), kind });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.status(), decision);
  }
  await f.send(initial("Use the exact model selected by the client."), { turnId: randomUUID(), model: "gpt-5.6-luna" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.status().manual, true);
  assert.equal(f.seen.at(-1).reasoning.effort, "max");
});

test("metadata identity survives turn changes without mixing threads sharing a cache prefix", () => {
  const thread = randomUUID();
  const body = { prompt_cache_key: "shared", input: initial("Task") };
  const headers = id => ({ "x-codex-turn-metadata": JSON.stringify({ thread_id: id, turn_id: randomUUID() }) });
  assert.equal(codexConversationKey(body, headers(thread)), codexConversationKey(body, headers(thread)));
  assert.notEqual(codexConversationKey(body, headers(thread)), codexConversationKey(body, headers(randomUUID())));
});

test("string input routes as user text without changing the upstream payload", async t => {
  const f = await fixture(t, () => answer("gpt-6-astra@max"));
  await f.send("Analyze the transaction race.", { source: "none" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].prompt, "Analyze the transaction race.");
  assert.equal(f.seen[0].model, "gpt-6-astra");
  assert.equal(f.seen[0].input, "Analyze the transaction race.");
});

test("out-of-order accepted responses cannot replace a newer routing decision", async t => {
  const received = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, ({ prompt }) => answer(prompt === "Old request" ? "gpt-6-astra@max" : "gpt-5.6-luna@low", "routine", "complete"), {
    respond: async (body, res) => {
      if (body.input.at(-1).content === "Old request") { received.resolve(); await release.promise; }
      res.end("ok");
    },
  });
  const older = f.send(initial("Old request"), { turnId: randomUUID() });
  await received.promise;
  await f.send(initial("New request"), { turnId: randomUUID() });
  const newest = f.status();
  release.resolve();
  await older;
  assert.equal(newest.prompt, "New request");
  assert.deepEqual(f.status(), newest);
});

test("cancellation during classification forwards nothing and cannot establish a decision", async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), routed = Promise.withResolvers();
  const f = await fixture(t, async () => { entered.resolve(); await release.promise; routed.resolve(); return answer("gpt-6-astra@max"); });
  const abort = new AbortController();
  const pending = f.send(initial("Cancelled task"), { turnId: randomUUID(), signal: abort.signal });
  const rejected = assert.rejects(pending, error => error.name === "AbortError");
  await entered.promise;
  abort.abort();
  await rejected;
  await f.disconnected.at(-1);
  release.resolve();
  await routed.promise;
  assert.equal(f.seen.length, 0);
  assert.equal(f.status(), null);
});

test("a rejected upstream request leaves no cached evidence and its retry is reassessed", async t => {
  let reject = true;
  const f = await fixture(t, () => answer("gpt-6-astra@max"), { respond: (_body, res) => res.writeHead(reject ? 400 : 200).end("result") });
  const input = initial("A retried task"), turnId = randomUUID();
  assert.equal((await f.send(input, { turnId })).status, 400);
  assert.equal(f.status(), null);
  reject = false;
  assert.equal((await f.send(input, { turnId })).status, 200);
  assert.equal(f.calls.length, 2);
  assert.equal(f.status().model, "gpt-6-astra");
});

const completion = (res, cached = 128, written = 64) => res.writeHead(200, { "content-type": "text/event-stream" }).end(
  `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed",
    usage: { input_tokens: 300, input_tokens_details: { cached_tokens: cached, cache_write_tokens: written }, output_tokens: 12 } } })}\n\n`);

test("measured cache survives restart, protects an unchanged prefix and is not attributed to a compacted prefix", async t => {
  let next = answer("gpt-6-sol@max");
  const f = await fixture(t, () => next, { models: ["gpt-6-luna", "gpt-6-sol"], respond: (_body, res) => completion(res) });
  const turnId = randomUUID(), input = initial("Complete the proof.");
  await f.send(input, { turnId });
  assert.equal(f.status().usage.inputTokens, 300);
  assert.equal(f.status().cache.tokens, 192);
  await f.restart();
  next = answer("gpt-6-sol@low", "routine", "complete");
  input.push(result("verified", "The proof is complete; report the result."));
  await f.send(input, { turnId });
  assert.equal(f.seen.at(-1).model, "gpt-6-sol");
  assert.equal(f.seen.at(-1).reasoning.effort, "max");
  assert.equal(f.status().cachedPrefixTokens, 192);
  assert.match(f.status().reason, /cache-savings-unmeasured/);
  const before = f.status();
  await f.send(initial("Create a compact summary."), { turnId, kind: "compaction" });
  assert.deepEqual(f.status(), before);
  await f.send([{ role: "user", content: "Summary: the proof has been verified; only reporting remains." }], { turnId });
  assert.equal(f.seen.at(-1).model, "gpt-6-sol");
  assert.equal(f.seen.at(-1).reasoning.effort, "low");
  assert.equal(f.status().cachedPrefixTokens, 0);
});

test("uncached responses and missing usage do not invent a cache-rebuild veto", async t => {
  for (const reportUsage of [true, false]) await t.test(String(reportUsage), async t => {
    let next = answer("gpt-6-sol@max");
    const f = await fixture(t, () => next, { models: ["gpt-6-luna", "gpt-6-sol"], respond: (_body, res) => {
      if (reportUsage) completion(res, 0, 0); else res.end("no usage");
    } });
    const turnId = randomUUID(), input = initial("Complete the work.");
    await f.send(input, { turnId });
    next = answer("gpt-6-sol@low", "routine", "complete");
    input.push(result("done", "Verified; only the final report remains."));
    await f.send(input, { turnId });
    assert.equal(f.seen.at(-1).model, "gpt-6-sol");
    assert.equal(f.seen.at(-1).reasoning.effort, "low");
    assert.equal(f.status().cachedPrefixTokens, 0);
  });
});

test("late completion usage cannot overwrite a newer request's model or cache", async t => {
  const received = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, ({ prompt }) => answer(prompt === "Old request" ? "gpt-6-astra@max" : "gpt-5.6-luna@low", "routine", "complete"), {
    respond: async (body, res) => {
      if (body.input.at(-1).content === "Old request") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
        received.resolve(); await release.promise;
        res.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed",
          usage: { input_tokens: 999, input_tokens_details: { cached_tokens: 999 } } } })}\n\n`);
      } else completion(res, 0, 0);
    },
  });
  const older = f.send(initial("Old request"), { turnId: randomUUID() });
  await received.promise;
  await f.send(initial("New request"), { turnId: randomUUID() });
  const newest = f.status();
  release.resolve(); await older;
  assert.equal(newest.cache.tokens, 0);
  assert.equal(newest.usage.inputTokens, 300);
  assert.deepEqual(f.status(), newest);
});

test("manual selections collect usage and a failed stream clears it without overriding the picker", async t => {
  let fail = false;
  const f = await fixture(t, () => answer("gpt-6-sol@low", "routine", "complete"), {
    models: ["gpt-6-luna", "gpt-6-sol"], respond: (_body, res) => {
      if (fail) res.writeHead(200, { "content-type": "text/event-stream" }).end(
        'data: {"type":"response.failed","response":{"status":"failed","usage":{"input_tokens":100}}}\n\n');
      else completion(res);
    },
  });
  const input = initial("Complete the task."), turnId = randomUUID();
  await f.send(input, { turnId, model: "gpt-6-sol" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.status().manual, true);
  assert.equal(f.status().cache.tokens, 192);
  fail = true;
  input.push(result("done", "Verified. Report the result."));
  await f.send(input, { turnId });
  assert.match(f.status().reason, /cache-savings-unmeasured/);
  assert.equal(f.status().cache, undefined);
  assert.equal(f.status().usage, undefined);
  input.push({ role: "user", content: "Retry the final report." });
  await f.send(input, { turnId });
  assert.equal(f.seen.at(-1).reasoning.effort, "low");
});
