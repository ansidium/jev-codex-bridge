import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readJson, resolveHome, SOURCE } from "./installation.mjs";

export function activeModule(relativePath) {
  const state = join(resolveHome(), "state.json");
  const root = existsSync(state) ? readJson(state).active.root : SOURCE;
  return pathToFileURL(join(root, relativePath));
}
