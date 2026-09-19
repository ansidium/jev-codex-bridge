#!/usr/bin/env node
import { activeModule } from "../src/active.mjs";
const { codexStatusId, readStatus } = await import(activeModule("src/status.mjs"));
const { formatExplanation } = await import(activeModule("src/explain.mjs"));

const statusId = process.argv[2] ?? process.env.JEV_CODEX_STATUS_ID ??
  codexStatusId(process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID);
process.stdout.write(`${formatExplanation(readStatus(statusId))}\n`);
