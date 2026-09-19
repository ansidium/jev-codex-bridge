import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_HOME = join(homedir(), ".config", "jev-codex-bridge");
export const REPOSITORY = "https://github.com/ansidium/jev-codex-bridge.git";
export const readJson = path => JSON.parse(readFileSync(path, "utf8"));
export function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}
export function run(command, args, cwd, timeout = 120_000) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
export function npm(args, cwd) {
  const executable = process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : realpathSync(run("which", ["npm"]));
  return run(process.execPath, [executable, ...args], cwd, 300_000);
}

// Each mutation holds the same lock. A terminated updater leaves a recoverable PID.
export async function withLock(home, action) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, "update.lock");
  try { writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("An incomplete update lock needs inspection.");
    try { process.kill(pid, 0); }
    catch (probe) {
      if (probe.code !== "ESRCH") throw probe;
      rmSync(path);
      return withLock(home, action);
    }
    throw new Error(`Another installation operation is running (PID ${pid}).`);
  }
  try { return await action(); } finally { rmSync(path, { force: true }); }
}

export function treeHash(root) {
  const hash = createHash("sha256");
  const visit = directory => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (!directory && [".git", "node_modules"].includes(entry.name)) continue;
      const name = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in installation: ${name}`);
      if (entry.isDirectory()) visit(name);
      else { hash.update(name + "\0"); hash.update(readFileSync(join(root, name))); }
    }
  };
  visit("");
  return hash.digest("hex");
}
export function validateCandidate(root) {
  const pkg = readJson(join(root, "package.json"));
  if (pkg.name !== "jev-codex-bridge") throw new Error("Unexpected package identity.");
  npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], root);
  run(process.execPath, ["scripts/check-source.mjs"], root);
  run(process.execPath, ["--test", "test/**/*.test.mjs"], root, 180_000);
}
function describe(root, revision = null) {
  return { root, revision, version: readJson(join(root, "package.json")).version, hash: treeHash(root) };
}
function assertUnchanged(installation) {
  if (treeHash(installation.root) !== installation.hash) throw new Error("Installed source has local changes; preserving it and refusing replacement.");
}
export function stageLocal(home, source = SOURCE, validate = validateCandidate) {
  const root = join(home, "versions", `local-${Date.now()}-${randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });
  const pkg = readJson(join(source, "package.json"));
  const lockfile = existsSync(join(source, "npm-shrinkwrap.json")) ? "npm-shrinkwrap.json" : "package-lock.json";
  for (const name of new Set(["package.json", lockfile, ...pkg.files])) {
    if (!existsSync(join(source, name))) throw new Error(`Missing distribution file: ${name}`);
    cpSync(join(source, name), join(root, name), { recursive: true });
  }
  validate(root);
  return describe(root);
}
export function activate(home, candidate, previousState = {}) {
  if (previousState.active) assertUnchanged(previousState.active);
  assertUnchanged(candidate);
  const state = { ...previousState, active: candidate, previous: previousState.active ?? null, updatedAt: new Date().toISOString() };
  saveJson(join(home, "state.json"), state);
  return state;
}
export function updateInstallation(home, { validate = validateCandidate, repository = REPOSITORY } = {}) {
  const state = readJson(join(home, "state.json"));
  assertUnchanged(state.active);
  const revision = run("git", ["ls-remote", repository, "refs/heads/main"]).split(/\s/)[0];
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Repository has no main branch.");
  if (revision === state.active.revision) return { status: "current", revision };
  const root = join(home, "versions", `${revision.slice(0, 12)}-${Date.now()}`);
  mkdirSync(dirname(root), { recursive: true });
  run("git", ["clone", "--quiet", "--depth", "1", "--branch", "main", repository, root]);
  if (run("git", ["rev-parse", "HEAD"], root) !== revision) throw new Error("Source changed during download; retry the update.");
  validate(root);
  assertUnchanged(state.active);
  activate(home, describe(root, revision), state);
  return { status: "updated", revision, activation: "when the service is idle" };
}
export function rollbackInstallation(home) {
  const state = readJson(join(home, "state.json"));
  if (!state.previous) throw new Error("No previous installation is available.");
  // Pause automatic updates so a rollback is not immediately undone.
  return activate(home, state.previous, { ...state, autoUpdate: false });
}
export const resolveHome = value => resolve(value ?? process.env.JEV_BRIDGE_HOME ?? DEFAULT_HOME);
