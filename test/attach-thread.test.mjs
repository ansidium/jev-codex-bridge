import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachThread } from "../src/attach-thread.mjs";

const threadId = "00000000-0000-4000-8000-000000000001";
function server(t, mode = "ok") {
  const root = mkdtempSync(join(tmpdir(), "jev-attach-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const script = join(root, "server.mjs"), log = join(root, "requests.jsonl");
  writeFileSync(log, "");
  writeFileSync(script, `
    import { appendFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    const [log, mode] = process.argv.slice(2);
    const lines = createInterface({ input: process.stdin });
    lines.on("line", line => {
      const request = JSON.parse(line);
      appendFileSync(log, line + "\\n");
      if (request.method === "initialized") return;
      if (mode === "exit") { process.exit(1); }
      if (mode === "timeout") return;
      let result = {};
      if (request.method === "thread/read") {
        result = { thread: { id: request.params.threadId, modelProvider: "openai",
          status: { type: mode === "active" ? "active" : "notLoaded" } } };
      }
      if (request.method === "thread/resume") {
        if (mode === "writer") {
          console.log(JSON.stringify({ id: request.id, error: { code: -32600,
            message: "thread already has an active writer" } }));
          return;
        }
        result = { modelProvider: mode === "unchanged" ? "openai" : "jev", model: "jev-router" };
      }
      console.log(JSON.stringify({ method: "notification", params: {} }));
      console.log(JSON.stringify({ id: request.id, result }));
    });
  `);
  return {
    options: { command: { file: process.execPath, prefix: [script, log, mode], shell: false }, timeout: 3000 },
    requests: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
  };
}

test("attaching resumes the same thread with its provider and model together, without a turn", async t => {
  const mock = server(t);
  assert.deepEqual(await attachThread(threadId, mock.options), { threadId, modelProvider: "jev", model: "jev-router" });
  const requests = mock.requests();
  assert.deepEqual(requests.map(r => r.method), ["initialize", "initialized", "thread/read", "thread/resume"]);
  assert.deepEqual(requests.at(-1).params, { threadId, modelProvider: "jev", model: "jev-router", excludeTurns: true });
});

test("a thread owned by Desktop is never forced open or archived", async t => {
  const mock = server(t, "writer");
  await assert.rejects(attachThread(threadId, mock.options), /Close Codex Desktop/);
  assert.deepEqual(mock.requests().map(r => r.method), ["initialize", "initialized", "thread/read", "thread/resume"]);
});

test("an active turn is rejected before attempting to resume it", async t => {
  const mock = server(t, "active");
  await assert.rejects(attachThread(threadId, mock.options), /active turn/);
  assert.equal(mock.requests().some(r => r.method === "thread/resume"), false);
});

test("a resume that keeps the wrong provider is not reported as success", async t => {
  const mock = server(t, "unchanged");
  await assert.rejects(attachThread(threadId, mock.options), /did not select Jev/);
});

test("server termination rejects the pending request", async t => {
  const mock = server(t, "exit");
  await assert.rejects(attachThread(threadId, mock.options), /app-server exited/);
});

test("a server that stops responding is closed after the request timeout", async t => {
  const mock = server(t, "timeout");
  await assert.rejects(attachThread(threadId, { ...mock.options, timeout: 1000 }), /timed out/);
});

test("invalid IDs and a missing executable cannot start a migration", async () => {
  await assert.rejects(attachThread("--last", { command: null }), /thread ID/);
  await assert.rejects(attachThread(threadId, { command: null }), /not on PATH/);
});
