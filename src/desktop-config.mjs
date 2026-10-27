import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { readJson, saveJson } from "./installation.mjs";

const digest = text => createHash("sha256").update(text).digest("hex");
export function configureCodex(path, home, port) {
  // Named profiles are opt-in. Never replace Desktop's native provider or model.
  path = join(dirname(path), "jev.config.toml");
  const existed = existsSync(path);
  const original = existed ? readFileSync(path, "utf8") : "";
  const data = parse(original);
  data.model = "jev-router";
  data.model_provider = "jev";
  data.model_providers ??= {};
  data.model_providers.jev = { name: "Jev Router", base_url: `http://127.0.0.1:${port}`,
    wire_api: "responses", requires_openai_auth: true, supports_websockets: false };
  const text = stringify(data);
  const backup = join(home, "backups", `config-${Date.now()}.toml`);
  mkdirSync(dirname(backup), { recursive: true });
  writeFileSync(backup, original, { mode: 0o600 });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  saveJson(join(home, "codex-config.json"), { path, backup, existed, installedHash: digest(text) });
  return backup;
}
export function restoreCodex(home) {
  const record = readJson(join(home, "codex-config.json"));
  if (digest(readFileSync(record.path, "utf8")) !== record.installedHash) {
    throw new Error(`Codex configuration changed after setup; restore the desired values manually from ${record.backup}.`);
  }
  if (record.existed === false) rmSync(record.path);
  else writeFileSync(record.path, readFileSync(record.backup), { mode: 0o600 });
  rmSync(join(home, "codex-config.json"));
  return record.path;
}
