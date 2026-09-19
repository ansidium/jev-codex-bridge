#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_HOME } from "../src/installation.mjs";

// Follow the validated installation for management commands as well as the service.
const index = process.argv.indexOf("--home");
const home = index < 0 ? process.env.JEV_BRIDGE_HOME ?? DEFAULT_HOME : process.argv[index + 1];
const statePath = join(home ?? DEFAULT_HOME, "state.json");
const root = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).active.root : null;
const module = root ? pathToFileURL(join(root, "src", "bridge-cli.mjs")) : new URL("../src/bridge-cli.mjs", import.meta.url);
try { await (await import(module)).main(process.argv.slice(2)); }
catch (error) { console.error(`[jev-bridge] ${error.message}`); process.exitCode = 1; }
