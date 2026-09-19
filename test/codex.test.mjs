import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addJevModel,
  applyCodexTier,
  applyCodexEffort,
  codexConversationKey,
  codexModels,
  codexNewTurnPrompt,
  codexPreviousUserPrompt,
  isCodexAuxiliaryPrompt,
  jevDecisionEvents,
  startCodexProxy,
  upstreamFor,
} from "../src/codex-proxy.mjs";
import { codexArgs, installCodexSkill } from "../src/codex-cli.mjs";
import { questionForModels } from "../src/config.mjs";
import { readStatus, STATUS_DIR, writeStatus } from "../src/status.mjs";

const explainCommand = (threadId, args = [], extraEnv = {}) => {
  const env = { ...process.env, JEV_BRIDGE_HOME: join(tmpdir(), `jev-uninstalled-${randomUUID()}`), ...extraEnv };
  delete env.JEV_CODEX_STATUS_ID;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  Object.assign(env, { CODEX_THREAD_ID: threadId }, extraEnv);
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../bin/jev-explain.mjs", import.meta.url)), ...args,
  ], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test("Codex frontier guidance follows the configured model id", (t) => {
  const previous = process.env.JEV_CODEX_LONG_MODEL;
  process.env.JEV_CODEX_LONG_MODEL = "configured-frontier-model";
  t.after(() => {
    if (previous === undefined) delete process.env.JEV_CODEX_LONG_MODEL;
    else process.env.JEV_CODEX_LONG_MODEL = previous;
  });
  const question = questionForModels(codexModels(new Map([["configured-frontier-model", {
    slug: "configured-frontier-model", description: "Catalog capability description",
  }]])));
  assert.deepEqual(Object.keys(question.criteria), ["configured-frontier-model"]);
  assert.match(question.criteria["configured-frontier-model"].model, /Catalog capability description/);
  assert.match(question.criteria["configured-frontier-model"].what, /regardless of task length/);
});

test("Desktop explanation isolates chats and preserves the last decision during tools", async (t) => {
  const threadA = randomUUID();
  const threadB = randomUUID();
  const statusA = `codex-thread-${threadA}`;
  const statusB = `codex-thread-${threadB}`;
  t.after(() => {
    for (const id of [statusA, statusB]) {
      try { unlinkSync(join(STATUS_DIR, `${id}.json`)); } catch {}
    }
  });
  const upstream = http.createServer((req, res) => { req.resume(); res.end("ok"); });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  let routeCalls = 0;
  const { port, close } = await startCodexProxy({
    apiBaseURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => { routeCalls++; return { choice: "gpt-5.6-sol", confidence: 0.9 }; },
  });
  t.after(close);
  const send = async (thread, prompt, model = "jev-router", options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.bodyId ? {} : { "thread-id": thread }) },
      body: JSON.stringify({ model, prompt_cache_key: thread,
        client_metadata: options.bodyId ? { thread_id: thread } : {},
        input: [
          { type: "additional_tools", role: "developer", tools: [{}] },
          { role: "user", content: prompt },
          ...(options.tool ? [{ type: "function_call_output", call_id: "1", output: "done" }] : []),
        ],
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
  };
  await send(threadA, "alpha chat decision");
  await send(threadB, "beta chat decision", "jev-router", { bodyId: true });
  assert.equal(readStatus(statusA)?.prompt, "alpha chat decision");
  assert.equal(readStatus(statusB)?.prompt, "beta chat decision");
  assert.match(explainCommand(threadA), /Prompt: alpha chat decision/);
  assert.match(explainCommand(threadB), /Prompt: beta chat decision/);
  assert.doesNotMatch(explainCommand(threadA), /beta chat/);
  assert.match(explainCommand(randomUUID()), /no routing decision/);
  await send(threadA, "alpha chat decision", "jev-router", { tool: true });
  await send(threadA, "$jev-explain");
  assert.equal(routeCalls, 2);
  assert.equal(readStatus(statusA).history.length, 1);
  assert.match(explainCommand(threadA), /Prompt: alpha chat decision/);
  await send(threadB, "manual choice", "gpt-5.6-luna");
  assert.match(explainCommand(threadB), /selected a model manually/);
  assert.match(explainCommand(threadA), /Prompt: alpha chat decision/);
});

test("explanation keeps explicit and CLI session selection ahead of Desktop", (t) => {
  const thread = randomUUID();
  const desktop = `codex-thread-${thread}`;
  const cli = `codex-test-${randomUUID()}`;
  t.after(() => {
    for (const id of [desktop, cli]) {
      try { unlinkSync(join(STATUS_DIR, `${id}.json`)); } catch {}
    }
  });
  writeStatus(desktop, { prompt: "desktop selected", model: "gpt-5.6-sol" });
  writeStatus(cli, { prompt: "cli selected", model: "gpt-5.6-terra" });
  assert.match(explainCommand(thread, [], { JEV_CODEX_STATUS_ID: cli }), /Prompt: cli selected/);
  assert.match(explainCommand(thread, [desktop], { JEV_CODEX_STATUS_ID: cli }), /Prompt: desktop selected/);
  assert.match(explainCommand(undefined, [], { CODEX_SESSION_ID: thread }), /Prompt: desktop selected/);
});

test("large fresh Desktop chats can start cheap and restore their model after restart", async (t) => {
  const thread = randomUUID();
  const record = `codex-thread-${thread}`;
  t.after(() => { try { unlinkSync(join(STATUS_DIR, `${record}.json`)); } catch {} });
  const seen = [];
  const catalog = { models: ["gpt-5.6-luna", "gpt-5.6-sol"].map(slug => ({ slug,
    supported_reasoning_levels: [{ effort: "low", description: "Quick" }, { effort: "high", description: "Deep" }],
    default_reasoning_level: "high" })) };
  const upstream = http.createServer((req, res) => {
    if (req.url === "/models") return res.end(JSON.stringify(catalog));
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => { seen.push(JSON.parse(Buffer.concat(chunks))); res.end("ok"); });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  let routeCalls = 0;
  const options = {
    apiBaseURL: `http://127.0.0.1:${upstream.address().port}`,
    chatgptBaseURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ prompt, previousPrompt, reasoningLevels }) => {
      routeCalls++;
      assert.deepEqual(reasoningLevels.map(level => level.effort), ["low", "high"]);
      if (prompt === "hard") assert.equal(previousPrompt, "simple");
      return { choice: prompt === "hard" ? "gpt-5.6-sol" : "gpt-5.6-luna", confidence: 0.99,
        reasoning: { choice: "low", confidence: 0.99 } };
    },
  };
  const send = async (port, prompt, tool = false) => {
    const response = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST", headers: { "content-type": "application/json", "thread-id": thread },
      body: JSON.stringify({ model: "jev-router", reasoning: { effort: "high" }, prompt_cache_key: thread, input: [
        { role: "developer", content: "context ".repeat(12000) },
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: prompt },
        ...(tool ? [{ type: "function_call_output", call_id: "1", output: "done" }] : []),
      ] }),
    });
    await response.text();
  };
  const first = await startCodexProxy(options);
  t.after(first.close);
  await fetch(`http://127.0.0.1:${first.port}/models`).then(response => response.text());
  await send(first.port, "simple");
  assert.equal(seen.at(-1).model, "gpt-5.6-luna");
  assert.equal(seen.at(-1).reasoning.effort, "low");
  assert.equal(readStatus(record).reasoningEffort, "low");
  first.close();
  const restored = await startCodexProxy(options);
  t.after(restored.close);
  await fetch(`http://127.0.0.1:${restored.port}/models`).then(response => response.text());
  await send(restored.port, "simple", true);
  assert.equal(seen.at(-1).model, "gpt-5.6-luna");
  assert.equal(seen.at(-1).reasoning.effort, "low");
  assert.equal(routeCalls, 1);
  await send(restored.port, "hard");
  assert.equal(seen.at(-1).model, "gpt-5.6-sol");
  await send(restored.port, "simple");
  assert.equal(seen.at(-1).model, "gpt-5.6-sol");
  assert.match(readStatus(record).reason, /cache-rebuild/);
});

test("adaptive reasoning respects catalog support and the user's ceiling", () => {
  const info = { supported_reasoning_levels: [{ effort: "shallow" }, { effort: "deep" }], default_reasoning_level: "deep" };
  assert.equal(applyCodexEffort({ reasoning: { effort: "deep" } }, "shallow", info).reasoning.effort, "shallow");
  assert.equal(applyCodexEffort({ reasoning: { effort: "shallow" } }, "deep", info).reasoning.effort, "shallow");
  assert.equal(applyCodexEffort({ reasoning: { effort: "deep" } }, "invented", info).reasoning.effort, "deep");
  assert.equal(applyCodexEffort({ reasoning: { effort: "deep" } }, "shallow", {}).reasoning.effort, "deep");
  assert.equal(applyCodexEffort({}, "shallow", info).reasoning.effort, "shallow");
});

test("a higher picker ceiling maps to the selected model's supported maximum", () => {
  const info = { supported_reasoning_levels: ["low", "medium", "max"].map(effort => ({ effort })), default_reasoning_level: "medium" };
  const picker = { supported_reasoning_levels: [...info.supported_reasoning_levels, { effort: "ultra" }] };
  const body = () => ({ reasoning: { effort: "medium" } });
  assert.equal(applyCodexEffort(body(), "max", info, "ultra", picker).reasoning.effort, "max");
  assert.equal(applyCodexEffort(body(), undefined, info, "ultra", picker).reasoning.effort, "max");
  assert.equal(applyCodexEffort(body(), "low", info, "ultra", picker).reasoning.effort, "low");
  assert.equal(applyCodexEffort({ reasoning: { effort: "max" } }, "ultra", picker, "max", picker).reasoning.effort, "max");
  assert.equal(applyCodexEffort(body(), "ultra", picker, "ultra", picker).reasoning.effort, "ultra");
});

test("previous task context skips injected environment messages and remains bounded", () => {
  const input = [
    { role: "user", content: "Investigate the database race" },
    { role: "user", content: "<environment_context>metadata</environment_context>" },
    { role: "user", content: "Yes, do it" },
  ];
  assert.equal(codexPreviousUserPrompt({ input }), "Investigate the database race");
  input[0].content = "x".repeat(3000);
  assert.equal(codexPreviousUserPrompt({ input }).length, 2000);
});

test("Codex uses a temporary authenticated Jev provider", () => {
  const args = codexArgs("http://127.0.0.1:1234", ["--sandbox", "read-only"]);
  assert.deepEqual(args.slice(0, 2), ["--model", "jev-router"]);
  assert(args.includes('model_provider="jev"'));
  assert(args.includes("model_providers.jev.requires_openai_auth=true"));
  assert.deepEqual(args.slice(-2), ["--sandbox", "read-only"]);
  assert.equal(codexArgs("http://127.0.0.1:1234", ["--model", "gpt-5.6-sol"]).filter((a) => a === "--model").length, 1);
});

test("installs the bundled explanation skill for Codex", (t) => {
  const home = mkdtempSync(join(tmpdir(), "jev-codex-skill-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = installCodexSkill(home);
  assert.match(target, /jev-router-explain[\\/]SKILL\.md$/);
  assert.match(readFileSync(target, "utf8"), /name: jev-explain/);
});

test("exec receives provider overrides after its subcommand", () => {
  for (const command of ["exec", "e"]) {
    const args = codexArgs("http://127.0.0.1:1234", [command, "--ephemeral", "Reply OK"]);
    assert.equal(args[0], command);
    assert(args.indexOf('model_provider="jev"') > 0);
    assert.deepEqual(args.slice(-2), ["--ephemeral", "Reply OK"]);
    const manual = codexArgs("http://127.0.0.1:1234", [command, "--model", "gpt-5.6-sol", "Reply OK"]);
    assert.equal(manual.filter(arg => arg === "--model").length, 1);
    assert(!manual.includes("jev-router"));
  }
});

test("reads only fresh Codex user turns", () => {
  const body = {
    input: [
      { type: "additional_tools", role: "developer", tools: [{}] },
      { role: "user", content: [{ type: "input_text", text: "Fix the bug" }] },
      { role: "user", content: [{ type: "input_text", text: "<system_reminder>tools</system_reminder>" }] },
      {
        role: "user",
        content: "<environment_context><current_date>2026-09-17</current_date></environment_context>",
      },
    ],
  };
  assert.equal(codexNewTurnPrompt(body), "Fix the bug");
  body.input.push({ type: "function_call_output", call_id: "1", output: "done" });
  assert.equal(codexNewTurnPrompt(body), null);
  assert.equal(
    codexNewTurnPrompt({
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: "Generate a concise, single-line task title of at most 36 characters" },
        {
          role: "user",
          content: "<environment_context><timezone>Asia/Calcutta</timezone></environment_context>",
        },
      ],
    }),
    null,
  );
  assert.equal(isCodexAuxiliaryPrompt("Generate a concise, single-line task title of at most 36 characters"), true);
});

test("keeps sub-agent routing state separate", () => {
  const base = { input: [{ role: "user", content: "same prompt" }] };
  assert.notEqual(
    codexConversationKey({ ...base, prompt_cache_key: "main" }),
    codexConversationKey({ ...base, prompt_cache_key: "sub-agent" }),
  );
});

test("adds Jev Router to the native model catalog", () => {
  const catalog = addJevModel({
    models: [{
      slug: "gpt-5.6-terra",
      display_name: "GPT-5.6-Terra",
      visibility: "list",
      supported_in_api: true,
      priority: 2,
    }],
  });
  assert.equal(catalog.models[0].slug, "jev-router");
  assert.equal(catalog.models[0].display_name, "Jev Router");
  assert.equal(catalog.models[1].slug, "gpt-5.6-terra");
});

test("routes subscription auth to ChatGPT and API keys to the public API", () => {
  assert.equal(
    upstreamFor({ "chatgpt-account-id": "acct" }, "/responses"),
    "https://chatgpt.com/backend-api/codex",
  );
  assert.equal(upstreamFor({ authorization: "Bearer sk-test" }, "/responses"), "https://api.openai.com/v1");
  assert.equal(upstreamFor({ authorization: "Bearer sk-test" }, "/models"), "https://chatgpt.com/backend-api/codex");
});

test("maps tiers and clamps unsupported reasoning effort", () => {
  const body = { model: "jev-router", reasoning: { effort: "max" } };
  const models = new Map([[
    "gpt-5.6-luna",
    { default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium" }] },
  ]]);
  applyCodexTier(body, "haiku", models);
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.reasoning.effort, "medium");
});

test("sends exact available GPT models to Jev", () => {
  const models = new Map([
    ["gpt-5.6-terra", { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra" }],
    ["gpt-5.6-sol", { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" }],
  ]);
  assert.deepEqual(codexModels(models).map(({ id, tier }) => ({ id, tier })), [
    { id: "gpt-5.6-terra", tier: "sonnet" },
    { id: "gpt-5.6-sol", tier: "opus" },
  ]);
});

test("surfaces routing as a native commentary event", () => {
  const events = jevDecisionEvents({ tier: "opus", confidence: 0.91, reason: "jev" });
  assert.match(events, /response\.output_item\.added/);
  assert.match(events, /response\.output_text\.delta/);
  assert.match(events, /response\.output_item\.done/);
  assert.match(events, /"phase":"commentary"/);
  assert.match(events, /\[Jev\] routed this turn to gpt-5\.6-sol/);
  assert.match(events, /confidence 0\.91/);

  const unavailable = jevDecisionEvents({
    tier: "sonnet",
    confidence: null,
    reason: "jev-unavailable/no-change",
  });
  assert.match(unavailable, /JEV_API_KEY=\.\.\. to ~\/\.jev-router\.env/);
  assert.match(unavailable, /using gpt-5\.6-terra/);
});

test("proxy preserves Codex auth, picker, routing, and native decision output", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        url: req.url,
        authorization: req.headers.authorization,
        account: req.headers["chatgpt-account-id"],
        body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null,
      });
      if (req.url.startsWith("/backend-api/codex/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({
          models: [{
            slug: "gpt-5.6-terra",
            display_name: "GPT-5.6-Terra",
            visibility: "list",
            supported_in_api: true,
            priority: 2,
          }, {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6-Sol",
            visibility: "list",
            supported_in_api: true,
            priority: 3,
          }],
        }));
      }
      res.end(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n',
      );
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
  const statusId = `codex-test-${process.pid}`;
  let routeCalls = 0;
  const { port, close } = await startCodexProxy({
    chatgptBaseURL: `${upstreamURL}/backend-api/codex`,
    apiBaseURL: `${upstreamURL}/v1`,
    route: async ({ models }) => {
      routeCalls++;
      assert.deepEqual(models.map((model) => model.id), ["gpt-5.6-terra", "gpt-5.6-sol"]);
      return {
        choice: "gpt-5.6-sol",
        confidence: 0.91,
        request: { state: { request: "debug this race" } },
        response: { answers: { model: { choice: "gpt-5.6-sol", confidence: 0.91 } } },
        metrics: {
          taskComplexity: 0.82,
          reasoningRequired: 0.91,
          toolComplexity: 0.64,
          contextSize: 0.31,
        },
      };
    },
    statusId,
  });
  t.after(close);
  const headers = { authorization: "Bearer subscription-token", "chatgpt-account-id": "acct" };

  const catalog = await fetch(`http://127.0.0.1:${port}/models?client_version=1`, { headers }).then((r) => r.json());
  assert.equal(catalog.models[0].slug, "jev-router");

  const response = await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      prompt_cache_key: "main",
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: [{ type: "input_text", text: "debug this race" }] },
      ],
    }),
  }).then((r) => r.text());

  assert.equal(seen[0].authorization, "Bearer subscription-token");
  assert.equal(seen[0].account, "acct");
  assert.equal(seen[1].body.model, "gpt-5.6-sol");
  assert.equal(readStatus(statusId).tier, "opus");
  assert.equal(readStatus(statusId).model, "gpt-5.6-sol");
  assert.equal(readStatus(statusId).prompt, "debug this race");
  assert.equal(readStatus(statusId).jev.request.state.request, "debug this race");
  assert.equal(readStatus(statusId).history.length, 1);
  assert.equal(readStatus(statusId).metrics.reasoningRequired, 0.91);
  assert(response.indexOf("response.created") < response.indexOf("[Jev] routed this turn"));
  assert(response.indexOf("[Jev] routed this turn") < response.indexOf("response.completed"));

  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: "Generate a concise, single-line task title of at most 36 characters" },
        {
          role: "user",
          content: "<environment_context><timezone>Asia/Calcutta</timezone></environment_context>",
        },
      ],
    }),
  });
  assert.equal(routeCalls, 1);
  assert.equal(readStatus(statusId).confidence, 0.91);
  assert.equal(readStatus(statusId).history.length, 1);

  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      prompt_cache_key: "main",
      input: [{ role: "user", content: [{ type: "input_text", text: "$jev-explain" }] }],
    }),
  });
  assert.equal(routeCalls, 1);
  assert.equal(seen[3].body.model, "gpt-5.6-sol");
  assert.equal(readStatus(statusId).metrics.reasoningRequired, 0.91);
});
