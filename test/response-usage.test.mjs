import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { cachePrefix, reusableCacheTokens, measuredUsage, observeUsage } from "../src/response-usage.mjs";

const usage = { input_tokens: 500, input_tokens_details: { cached_tokens: 128, cache_write_tokens: 256 },
  output_tokens: 40, output_tokens_details: { reasoning_tokens: 16 } };
const measured = { inputTokens: 500, cachedInputTokens: 128, cacheWriteInputTokens: 256, outputTokens: 40, reasoningTokens: 16 };

test("cache evidence requires the same actual request prefix, model, effort and cache key", () => {
  const body = { model: "model", reasoning: { effort: "max" }, instructions: "rules", tools: [{ name: "read" }],
    prompt_cache_key: "thread", input: [{ role: "user", content: "task" }, { type: "reasoning", encrypted_content: "opaque" }] };
  const cache = { ...cachePrefix(body), tokens: 384 };
  const continued = { ...body, input: [...body.input, { type: "function_call_output", output: "result" }],
    client_metadata: { turn_id: "next" }, stream: true, store: false };
  assert.equal(reusableCacheTokens(continued, cache), 384);
  for (const patch of [{ model: "another" }, { reasoning: { effort: "low" } }, { prompt_cache_key: "other" },
    { instructions: "new rules" }, { tools: [] }, { input: [{ type: "compaction", encrypted_content: "summary" }] },
    { input: [body.input[0], { type: "reasoning", encrypted_content: "changed" }] }]) {
    assert.equal(reusableCacheTokens({ ...continued, ...patch }, cache), 0);
  }
  assert.equal(reusableCacheTokens(continued, undefined), 0);
  assert.equal(reusableCacheTokens(continued, { ...cache, tokens: -1 }), 0);
  assert.equal(JSON.stringify(cache).includes("opaque"), false);
});

test("usage keeps missing measurements distinct from zero and rejects invalid cache counts", () => {
  assert.deepEqual(measuredUsage(usage), measured);
  assert.deepEqual(measuredUsage({ input_tokens: 10 }), { inputTokens: 10 });
  assert.deepEqual(measuredUsage({ input_tokens: 10, input_tokens_details: { cached_tokens: 0 } }),
    { inputTokens: 10, cachedInputTokens: 0 });
  for (const invalid of [null, {}, { input_tokens: -1 }, { ...usage, input_tokens: 100 },
    { ...usage, input_tokens_details: { cached_tokens: -1 } }, { ...usage, input_tokens_details: { cached_tokens: "128" } }]) {
    assert.equal(measuredUsage(invalid), null);
  }
});

test("fragmented SSE, CRLF, multiline data and UTF-8 are observed without changing any bytes", async () => {
  const response = new PassThrough();
  response.headers = { "content-type": "text/event-stream" };
  const seen = [], forwarded = [];
  observeUsage(response, value => seen.push(value));
  response.on("data", chunk => forwarded.push(chunk));
  const completed = JSON.stringify({ type: "response.completed", response: { status: "completed", usage } });
  const source = Buffer.from('event: response.output_text.delta\r\ndata: {"delta":"\u041f\u0440\u0438\u0432\u0435\u0442"}\r\n\r\n' +
    'event: response.completed\r\ndata: ' + completed.replace(',"response":', ',\r\ndata: "response":') + '\r\n\r\ndata: [DONE]\r\n\r\n');
  for (const byte of source) { response.write(Buffer.from([byte])); await setImmediate(); }
  response.end();
  await setImmediate();
  assert.deepEqual(seen, [measured]);
  assert.deepEqual(Buffer.concat(forwarded), source);
});

test("failed or incomplete streams do not establish reusable cache; completed JSON does", async () => {
  for (const status of ["failed", "incomplete", "completed"]) {
    const response = new PassThrough(), seen = [];
    response.headers = { "content-type": "application/json" };
    observeUsage(response, value => seen.push(value));
    response.end(JSON.stringify({ status, usage }));
    await setImmediate();
    assert.deepEqual(seen, status === "completed" ? [measured] : []);
  }
  const response = new PassThrough(), seen = [];
  response.headers = { "content-type": "text/event-stream" };
  observeUsage(response, value => seen.push(value));
  response.end(`data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", usage } })}\n\n`);
  await setImmediate();
  assert.deepEqual(seen, []);
});

test("subscription responses may omit Content-Type; the request stream flag defines framing", async () => {
  for (const streaming of [true, false]) {
    const response = new PassThrough(), seen = [];
    response.headers = {};
    observeUsage(response, value => seen.push(value), streaming);
    const body = { status: "completed", usage };
    response.end(streaming ? `data: ${JSON.stringify({ type: "response.completed", response: body })}\n\n` : JSON.stringify(body));
    await setImmediate();
    assert.deepEqual(seen, [measured]);
  }
});

test("a stream error closes observation without inventing usage or an unhandled error", async () => {
  const response = new PassThrough(), seen = [];
  response.headers = { "content-type": "text/event-stream" };
  observeUsage(response, value => seen.push(value));
  response.write('data: {"type":"response.created"}\n\n');
  response.destroy(new Error("upstream disconnected"));
  await setImmediate();
  assert.deepEqual(seen, []);
});
