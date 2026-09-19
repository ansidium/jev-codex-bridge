import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { activate, readJson, resolveHome, rollbackInstallation, run, saveJson, stageLocal, updateInstallation, withLock } from "./installation.mjs";
import { configureCodex, restoreCodex } from "./desktop-config.mjs";
import { health, startDesktopServer } from "./desktop-server.mjs";
import { installCodexSkill } from "./codex-cli.mjs";
import { attachThread } from "./attach-thread.mjs";
import { parse } from "smol-toml";

const help = `Jev Codex Bridge
  install [--key-file PATH] [--port 18767] [--codex-home PATH]
          [--no-config] [--no-service] [--task-name NAME] [--update-time HH:mm]
  status | update | rollback | serve | shutdown
  service start|stop|restart|status|remove
  service schedule --update-time HH:mm
  auto-update on|off
  configure | restore-config
  attach THREAD_ID [--codex-home PATH]
All commands accept --home PATH (or JEV_BRIDGE_HOME).
Desktop service installation uses Windows Task Scheduler. On other platforms,
use install --no-service, then serve under your own process supervisor.
`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function updateTime(value = new Date().toTimeString().slice(0, 5)) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("Update time must use HH:mm (local time).");
  return value;
}
function service(home, action, time) {
  if (process.platform !== "win32") throw new Error("Service management currently requires Windows; use serve on this platform.");
  const root = readJson(join(home, "state.json")).active.root;
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    join(root, "scripts", "windows-service.ps1"), "-Action", action, "-BridgeHome", home, "-Node", process.execPath,
    ...(time ? ["-UpdateTime", time] : [])], root, 30_000);
}
async function shutdown(home) {
  const { port } = readJson(join(home, "settings.json"));
  const response = await fetch(`http://127.0.0.1:${port}/__jev/stop`, { method: "POST",
    headers: { authorization: `Bearer ${readFileSync(join(home, "control.token"), "utf8").trim()}` }, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Cannot stop the service (${response.status}): ${await response.text()}`);
}
async function worker(home) {
  const settings = readJson(join(home, "settings.json"));
  const state = readJson(join(home, "state.json"));
  process.loadEnvFile(settings.keyFile);
  process.env.JEV_ALLOW_FABLE ??= "1";
  const server = await startDesktopServer({ port: settings.port,
    token: readFileSync(join(home, "control.token"), "utf8").trim(),
    version: `${state.active.version}+${state.active.revision?.slice(0, 12) ?? "local"}` });
  console.log(`Jev Codex Bridge listening on 127.0.0.1:${server.port}`);
  const timer = setInterval(() => {
    try {
      const next = readJson(join(home, "state.json")).active.root;
      if (next !== state.active.root && server.active === 0) {
        process.exitCode = 75;
        void server.close();
      }
    } catch (error) { console.error(`Cannot check installation state: ${error.message}`); }
  }, 2000);
  process.once("SIGTERM", () => { void server.close(); });
  process.once("SIGINT", () => { void server.close(); });
  await server.closed;
  clearInterval(timer);
}
async function supervise(home) {
  // The supervisor survives an idle worker restart; in-flight requests finish first.
  for (;;) {
    const { active } = readJson(join(home, "state.json"));
    const child = spawn(process.execPath, [join(active.root, "bin", "jev-bridge.mjs"), "worker", "--home", home], { stdio: "inherit", windowsHide: true });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
    if (code !== 75) { process.exitCode = code; return; }
  }
}
export async function main(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    home: { type: "string" }, "key-file": { type: "string" }, port: { type: "string" },
    "codex-home": { type: "string" }, "task-name": { type: "string" }, "no-config": { type: "boolean" },
    "no-service": { type: "boolean" }, automatic: { type: "boolean" }, help: { type: "boolean" },
    "update-time": { type: "string" },
  } });
  const [command, option] = positionals;
  if (!command || values.help) { console.log(help); return; }
  const home = resolveHome(values.home);
  if (command === "worker") return worker(home);
  if (command === "serve") return supervise(home);
  if (command === "shutdown") return shutdown(home);
  if (command === "status") {
    const state = readJson(join(home, "state.json"));
    let running;
    try { running = await health(home); } catch { running = { ready: false }; }
    console.log(JSON.stringify({ running, active: state.active, previous: state.previous, autoUpdate: state.autoUpdate }, null, 2));
    return;
  }
  if (command === "service") {
    if (option === "schedule") {
      if (!values["update-time"]) throw new Error("Provide --update-time HH:mm.");
      const time = updateTime(values["update-time"]);
      await withLock(home, () => {
        console.log(service(home, "schedule", time));
        const path = join(home, "settings.json");
        saveJson(path, { ...readJson(path), updateTime: time });
      });
      return;
    }
    if (!["start", "stop", "restart", "status", "remove"].includes(option)) throw new Error("Choose service start, stop, restart, status, remove, or schedule.");
    console.log(service(home, option)); return;
  }
  await withLock(home, async () => {
    if (command === "install") {
      if (existsSync(join(home, "state.json"))) throw new Error("Already installed here; use update or choose a separate --home.");
      const port = Number(values.port ?? 18767);
      const time = updateTime(values["update-time"]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be an integer from 1 to 65535.");
      const keyFile = resolve(values["key-file"] ?? join(homedir(), ".jev-router.env"));
      const keys = parseEnv(readFileSync(keyFile, "utf8"));
      if (!(keys.JEV_API_KEY || keys.TYPESAFE_API_KEY || process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY)) throw new Error("The key file must define JEV_API_KEY or TYPESAFE_API_KEY.");
      const taskName = values["task-name"] ?? "JevCodexBridge";
      if (!/^[a-zA-Z0-9_-]+$/.test(taskName)) throw new Error("Task name may contain letters, digits, hyphens, and underscores.");
      const candidate = stageLocal(home);
      writeFileSync(join(home, "control.token"), randomBytes(32).toString("hex"), { mode: 0o600 });
      saveJson(join(home, "settings.json"), { port, keyFile, taskName, updateTime: time });
      activate(home, candidate, { autoUpdate: true });
      // A stable launcher follows the active pointer without holding old source open.
      writeFileSync(join(home, "launch.mjs"), `import { readFileSync } from 'node:fs';\nimport { join, dirname } from 'node:path';\nimport { fileURLToPath, pathToFileURL } from 'node:url';\nconst home = dirname(fileURLToPath(import.meta.url));\nconst { active } = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));\nprocess.argv.push('--home', home);\nawait import(pathToFileURL(join(active.root, 'bin', 'jev-bridge.mjs')));\n`);
      if (!values["no-service"]) {
        service(home, "install");
        let ready = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          try { ready = (await health(home)).ready; } catch {}
          if (ready) break;
          await delay(200);
        }
        if (!ready) throw new Error("Service did not become ready; Codex configuration was not changed. Inspect service.log.");
      }
      if (!values["no-config"]) {
        installCodexSkill();
        const path = join(resolve(values["codex-home"] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")), "config.toml");
        const backup = configureCodex(path, home, port);
        console.log(`Codex configured; original saved to ${backup}`);
      }
      console.log(`Installed ${candidate.version} in ${home}`); return;
    }
    if (command === "restore-config") { console.log(restoreCodex(home)); return; }
    if (command === "attach") {
      if (!(await health(home)).ready) throw new Error("Start the service before attaching a thread.");
      const codexHome = resolve(values["codex-home"] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
      const config = parse(readFileSync(join(codexHome, "config.toml"), "utf8"));
      const { port } = readJson(join(home, "settings.json"));
      if (config.model_providers?.jev?.base_url !== `http://127.0.0.1:${port}`) {
        throw new Error("Configure this Codex home for the running bridge before attaching a thread.");
      }
      console.log(JSON.stringify(await attachThread(option, { codexHome })));
      return;
    }
    if (command === "configure") {
      if (existsSync(join(home, "codex-config.json"))) throw new Error("Configuration backup already exists; inspect it before configuring again.");
      if (!(await health(home)).ready) throw new Error("Start the service before configuring Codex.");
      installCodexSkill();
      const { port } = readJson(join(home, "settings.json"));
      const path = join(resolve(values["codex-home"] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")), "config.toml");
      console.log(`Original configuration saved to ${configureCodex(path, home, port)}`); return;
    }
    if (command === "auto-update") {
      if (!["on", "off"].includes(option)) throw new Error("Choose auto-update on or off.");
      const state = readJson(join(home, "state.json"));
      saveJson(join(home, "state.json"), { ...state, autoUpdate: option === "on" });
      console.log(`Automatic updates: ${option}`); return;
    }
    if (command === "rollback") { rollbackInstallation(home); console.log("Previous version selected; activation waits for idle. Automatic updates paused."); return; }
    if (command === "update") {
      if (values.automatic && !readJson(join(home, "state.json")).autoUpdate) return;
      try {
        const result = updateInstallation(home);
        if (process.platform === "win32") service(home, "refresh");
        saveJson(join(home, "update-status.json"), { ...result, checkedAt: new Date().toISOString() });
        console.log(JSON.stringify(result));
      } catch (error) {
        saveJson(join(home, "update-status.json"), { status: "failed", error: error.message, checkedAt: new Date().toISOString() });
        throw error;
      }
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  });
}
