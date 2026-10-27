import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { askJev } from "../src/router.mjs";

test("cancelled classifications close their connection; credit failures pause retries and return fallback", async t => {
  let calls = 0, hold = true;
  const received = Promise.withResolvers(), disconnected = Promise.withResolvers();
  const server = http.createServer((req, res) => {
    calls++;
    req.resume();
    if (hold) {
      res.once("close", () => disconnected.resolve());
      received.resolve();
    } else {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Synthetic fixture: no credits" }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const vars = { TYPESAFE_BASE_URL: `http://127.0.0.1:${server.address().port}`, JEV_API_KEY: "synthetic-key" };
  const before = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const current = { id: "gpt-6.1-sol@max", model: "gpt-6.1-sol", effort: "max" };
  const args = { prompt: "Synthetic fixture", current, profiles: [current], contextTokens: 10 };
  const abort = new AbortController();
  const pending = askJev({ ...args, signal: abort.signal });
  await received.promise;
  abort.abort();
  assert.equal(await pending, null);
  await disconnected.promise;
  assert.equal(calls, 1);
  hold = false;
  assert.equal(await askJev(args), null);
  assert.equal(calls, 2);
  assert.equal(await askJev(args), null);
  assert.equal(await askJev(args), null);
  assert.equal(calls, 2);
});
