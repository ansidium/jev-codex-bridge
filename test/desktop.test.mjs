import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startDesktopServer } from "../src/desktop-server.mjs";

test("Desktop gateway restricts browser access and refuses to stop an active request", async t => {
  let finish;
  let entered;
  const received = new Promise(resolve => { entered = resolve; });
  const upstream = http.createServer((req, res) => { req.resume(); finish = () => res.end("complete"); entered(); });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const server = await startDesktopServer({ port: 0, token: "synthetic-control-token", version: "test",
    proxyOptions: { apiBaseURL: `http://127.0.0.1:${upstream.address().port}` } });
  t.after(server.close);
  const url = `http://127.0.0.1:${server.port}`;
  assert.equal((await fetch(`${url}/__jev/health`)).status, 200);
  assert.equal((await fetch(`${url}/__jev/health`, { headers: { origin: "https://example.invalid" } })).status, 403);
  assert.equal((await fetch(`${url}/responses`)).status, 401);
  assert.equal((await fetch(`${url}/__jev/stop`, { method: "POST" })).status, 401);
  const request = fetch(`${url}/responses`, { method: "POST", headers: { authorization: "Bearer synthetic-upstream" }, body: '{"model":"manual"}' });
  await received;
  assert.equal(server.active, 1);
  const stop = () => fetch(`${url}/__jev/stop`, { method: "POST", headers: { authorization: "Bearer synthetic-control-token" } });
  assert.equal((await stop()).status, 409);
  finish();
  assert.equal(await (await request).text(), "complete");
  assert.equal((await stop()).status, 200);
  await server.closed;
});
test("a port conflict fails cleanly without starting a second service", async t => {
  const one = await startDesktopServer({ port: 0, token: "one", version: "test" });
  t.after(one.close);
  await assert.rejects(startDesktopServer({ port: one.port, token: "two", version: "test" }), /EADDRINUSE/);
});

test("cancelled Desktop requests release the upstream connection before shutdown", async t => {
  let disconnected;
  const cancelled = new Promise(resolve => { disconnected = resolve; });
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.write("stream started");
    res.once("close", disconnected);
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const server = await startDesktopServer({ port: 0, token: "control", version: "test",
    proxyOptions: { apiBaseURL: `http://127.0.0.1:${upstream.address().port}` } });
  t.after(server.close);
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${server.port}/responses`, {
    method: "POST", headers: { authorization: "Bearer synthetic-test" },
    body: '{"model":"manual"}', signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(response.text(), /abort/i);
  let timer;
  try {
    await Promise.race([cancelled, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Upstream still running after cancellation")), 1000);
    })]);
  } finally { clearTimeout(timer); }
  assert.equal(server.active, 0);
  await server.close();
});
