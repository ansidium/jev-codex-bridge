import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveCodex } from "./codex-cli.mjs";
import { CODEX_AUTO_MODEL } from "./codex-proxy.mjs";
import pkg from "../package.json" with { type: "json" };

/** Change a stored thread through Codex itself, without starting a model turn. */
export async function attachThread(threadId, { codexHome, command = resolveCodex(), timeout = 30_000 } = {}) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId ?? "")) {
    throw new Error("Provide a Codex thread ID (the UUID from its link).");
  }
  if (!command) throw new Error("Codex is not on PATH.");
  const child = spawn(command.file, [...command.prefix, "app-server", "--stdio"], {
    shell: command.shell, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  let failure;
  const fail = error => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  const closed = new Promise(resolve => child.once("close", resolve));
  child.once("exit", () => fail(new Error("Codex app-server exited before completing the request.")));
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex ${method} timed out. Check the thread before retrying.`));
    }, timeout);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await call("initialize", { clientInfo: { name: pkg.name, version: pkg.version } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const { thread } = await call("thread/read", { threadId, includeTurns: false });
    if (thread.status?.type === "active") throw new Error("Wait for this thread's active turn to finish before attaching it.");
    const result = await call("thread/resume", { threadId, modelProvider: "jev", model: CODEX_AUTO_MODEL, excludeTurns: true });
    if (result.modelProvider !== "jev" || result.model !== CODEX_AUTO_MODEL) {
      throw new Error("Codex did not select Jev Router. Check the thread before retrying.");
    }
    return { threadId, modelProvider: result.modelProvider, model: result.model };
  } catch (error) {
    if (/active writer/i.test(error.message)) {
      throw new Error("This thread is open in another Codex process. Close Codex Desktop and any CLI using it, then retry. Its history has not been changed.");
    }
    throw error;
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    await closed;
    clearTimeout(timer);
    lines.close();
  }
}
