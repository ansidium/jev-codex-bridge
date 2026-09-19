import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startCodexProxy } from "./codex-proxy.mjs";

export async function startDesktopServer({ port, token, version, proxyOptions = {} }) {
  const proxy = await startCodexProxy({ ...proxyOptions, authorize: req => !req.headers.origin && Boolean(req.headers.authorization) });
  let active = 0;
  let closing = false;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const close = () => {
    if (closing) return closed;
    closing = true;
    server.close(() => { proxy.close(); resolveClosed(); });
    return closed;
  };
  const server = http.createServer((req, res) => {
    const allowed = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
    if (!allowed.includes(req.headers.host) || req.headers.origin) { res.writeHead(403).end(); return; }
    if (req.url === "/__jev/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: !closing, version, active, pid: process.pid,
        instance: createHash("sha256").update(token).digest("hex") })); return;
    }
    if (req.url === "/__jev/stop" && req.method === "POST") {
      const supplied = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return; }
      if (active) { res.writeHead(409).end("Requests are active; retry when idle."); return; }
      res.end("Stopping"); void close(); return;
    }
    if (!req.headers.authorization) { res.writeHead(401).end(); return; }
    if (closing) { res.writeHead(503).end(); return; }
    active++;
    const upstream = http.request({ hostname: "127.0.0.1", port: proxy.port, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    res.once("close", () => { active--; upstream.destroy(); });
    req.on("error", () => upstream.destroy());
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  } catch (error) { proxy.close(); throw error; }
  return { port: server.address().port, get active() { return active; }, close, closed };
}
export async function health(home) {
  const { port } = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
  const response = await fetch(`http://127.0.0.1:${port}/__jev/health`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Health check failed (${response.status}).`);
  const result = await response.json();
  const expected = createHash("sha256").update(readFileSync(join(home, "control.token"), "utf8").trim()).digest("hex");
  if (result.instance !== expected) throw new Error("Port belongs to a different installation.");
  return result;
}
