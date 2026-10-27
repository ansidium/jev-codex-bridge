import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate, readJson, rollbackInstallation, run, saveJson, stageLocal, treeHash, updateInstallation, withLock } from "../src/installation.mjs";
import { configureCodex, restoreCodex } from "../src/desktop-config.mjs";
import { parse } from "smol-toml";
import { installMode, updateTime } from "../src/bridge-cli.mjs";

test("update scheduling accepts user time and rejects malformed clock values", () => {
  assert.equal(updateTime("00:00"), "00:00");
  assert.equal(updateTime("23:59"), "23:59");
  for (const time of ["24:00", "12:60", "noon", "1:30"]) assert.throws(() => updateTime(time), /HH:mm/);
});

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), "jev-bridge-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}
function source(root, version = "1.0.0") {
  mkdirSync(root, { recursive: true });
  saveJson(join(root, "package.json"), { name: "jev-codex-bridge", version, files: ["module.mjs"] });
  writeFileSync(join(root, "package-lock.json"), "{}");
  writeFileSync(join(root, "module.mjs"), "export default 1;\n");
  return root;
}
test("staging copies only distribution files and cannot activate a failed validation", t => {
  const root = workspace(t), home = join(root, "home"), src = source(join(root, "source"));
  writeFileSync(join(src, ".env"), "SYNTHETIC_SECRET=excluded");
  assert.throws(() => stageLocal(home, src, () => { throw new Error("test failure"); }), /test failure/);
  assert.throws(() => readJson(join(home, "state.json")), /ENOENT/);
  const candidate = stageLocal(home, src, () => {});
  assert.throws(() => readFileSync(join(candidate.root, ".env")), /ENOENT/);
  assert.equal(treeHash(candidate.root), candidate.hash);
});
test("activation preserves edited installations and rollback pauses updates", t => {
  const root = workspace(t), home = join(root, "home");
  const one = stageLocal(home, source(join(root, "one")), () => {});
  const two = stageLocal(home, source(join(root, "two"), "2.0.0"), () => {});
  const first = activate(home, one, { autoUpdate: true });
  writeFileSync(join(one.root, "local-note.txt"), "user data");
  assert.throws(() => activate(home, two, first), /local changes/);
  assert.equal(readJson(join(home, "state.json")).active.version, "1.0.0");
  rmSync(join(one.root, "local-note.txt"));
  activate(home, two, first);
  const rolled = rollbackInstallation(home);
  assert.equal(rolled.active.version, "1.0.0");
  assert.equal(rolled.autoUpdate, false);
});
test("one mutation lock covers staging and activation", async t => {
  const home = workspace(t);
  await withLock(home, async () => {
    await assert.rejects(withLock(home, async () => {}), /Another installation/);
  });
  await withLock(home, async () => {});
});
test("update validates an immutable revision before changing the active pointer", t => {
  const root = workspace(t), home = join(root, "home"), upstream = source(join(root, "upstream"));
  run("git", ["init", "-b", "main"], upstream);
  run("git", ["add", "."], upstream);
  run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], upstream);
  activate(home, stageLocal(home, upstream, () => {}), { autoUpdate: true });
  const before = readFileSync(join(home, "state.json"), "utf8");
  assert.throws(() => updateInstallation(home, { repository: upstream, validate: () => { throw new Error("invalid candidate"); } }), /invalid candidate/);
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), before);
  const result = updateInstallation(home, { repository: upstream, validate: () => {} });
  assert.equal(result.status, "updated");
  assert.equal(updateInstallation(home, { repository: upstream }).status, "current");
});
test("CLI installation is lightweight; Desktop service and profile require opt-in", () => {
  assert.deepEqual(installMode({}), { service: false, configure: false });
  assert.deepEqual(installMode({ desktop: true }), { service: true, configure: true });
  assert.deepEqual(installMode({ desktop: true, "no-service": true }), { service: false, configure: true });
  assert.deepEqual(installMode({ desktop: true, "no-config": true }), { service: true, configure: false });
});
test("Codex setup writes only the optional profile and preserves the native configuration byte for byte", t => {
  const home = workspace(t), path = join(home, "codex", "config.toml");
  mkdirSync(join(home, "codex"));
  const original = '# keep this comment\nmodel = "manual"\n[features]\nmulti_agent = true\n[projects."C:\\\\Example"]\ntrust_level = "trusted"\n';
  writeFileSync(path, original);
  const backup = configureCodex(path, home, 45678);
  const profile = join(home, "codex", "jev.config.toml");
  const configured = parse(readFileSync(profile, "utf8"));
  assert.equal(readFileSync(path, "utf8"), original);
  assert.equal(configured.model, "jev-router");
  assert.equal(configured.model_provider, "jev");
  assert.equal(configured.model_providers.jev.base_url, "http://127.0.0.1:45678");
  assert.equal(readFileSync(backup, "utf8"), "");
  restoreCodex(home);
  assert.equal(readFileSync(path, "utf8"), original);
  assert.equal(existsSync(profile), false);
  assert.equal(existsSync(join(home, "codex-config.json")), false);
  // Restoring must not leave a stale setup record that blocks reconfiguration.
  configureCodex(path, home, 45678);
  restoreCodex(home);
  assert.equal(readFileSync(path, "utf8"), original);
});
test("configuration restore never overwrites edits made after setup", t => {
  const home = workspace(t), path = join(home, "config.toml");
  configureCodex(path, home, 45678);
  const profile = join(home, "jev.config.toml");
  const edited = readFileSync(profile, "utf8") + '\n# later user edit\n';
  writeFileSync(profile, edited);
  assert.throws(() => restoreCodex(home), /changed after setup/);
  assert.equal(readFileSync(profile, "utf8"), edited);
});
