#!/usr/bin/env node
import { activeModule } from "../src/active.mjs";
const { runCodex } = await import(activeModule("src/codex-cli.mjs"));

await runCodex();
