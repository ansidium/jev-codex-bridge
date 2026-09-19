import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Windows service host has no console and preserves output, arguments and failure exit codes", {
  skip: process.platform !== "win32",
}, t => {
  const home = mkdtempSync(join(tmpdir(), "jev service host "));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const executable = join(home, "host.exe");
  const source = fileURLToPath(new URL("../scripts/WindowsServiceHost.cs", import.meta.url));
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const compiled = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -Path ${quote(source)} -OutputAssembly ${quote(executable)} -OutputType WindowsApplication`],
  { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const pe = readFileSync(executable);
  const header = pe.readUInt32LE(0x3c);
  assert.equal(pe.readUInt16LE(header + 24 + 68), 2, "GUI subsystem must not allocate a console");
  writeFileSync(join(home, "launch.mjs"), `
    console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));
    console.error("\\u041f\\u0440\\u043e\\u0432\\u0435\\u0440\\u043a\\u0430");
    process.exitCode = 7;
  `);
  const legacyLog = Buffer.from("\ufeffprevious log\r\n", "utf16le");
  writeFileSync(join(home, "serve.log"), legacyLog);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(executable, [home, process.execPath, "serve"], { env, stdio: "ignore", windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 7, String(result.error ?? ""));
  const log = readFileSync(join(home, "serve.log"), "utf8");
  assert.deepEqual(readFileSync(join(home, "serve.log.previous")), legacyLog);
  assert(log.includes("\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430"));
  const record = JSON.parse(log.split(/\r?\n/).find(line => line.startsWith("{")));
  assert.deepEqual(record, { args: ["serve", "--automatic"], cwd: realpathSync.native(home) });
});
