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
import { previousRoutingContext } from "../src/config.mjs";
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
  const previousPrompts = [];
  const { port, close } = await startCodexProxy({
    apiBaseURL: `http://127.0.0.1:${upstream.address().port}`,
    chatgptBaseURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ previousPrompt }) => { routeCalls++; previousPrompts.push(previousPrompt); return { choice: "gpt-6-sol@low", confidence: 0.9 }; },
  });
  t.after(close);
  const send = async (thread, prompt, model = "jev-router", options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.bodyId ? {} : { "thread-id": thread }),
        "x-codex-turn-metadata": JSON.stringify({ request_kind: options.kind ?? "turn" }) },
      body: JSON.stringify({ model, prompt_cache_key: "shared-cache-prefix",
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
  assert.deepEqual(previousPrompts, [undefined, undefined]);
  assert.equal(readStatus(statusA)?.prompt, "alpha chat decision");
  assert.equal(readStatus(statusA)?.previousModel, "gpt-6-sol");
  assert.equal(readStatus(statusA)?.previousReasoningEffort, "max");
  assert.equal(readStatus(statusB)?.prompt, "beta chat decision");
  assert.match(explainCommand(threadA), /Prompt: alpha chat decision/);
  assert.match(explainCommand(threadB), /Prompt: beta chat decision/);
  assert.doesNotMatch(explainCommand(threadA), /beta chat/);
  assert.match(explainCommand(randomUUID()), /no routing decision/);
  await send(threadA, "background summary", "gpt-5.6-luna", { kind: "summary" });
  await send(threadA, "alpha chat decision", "jev-router", { tool: true });
  await send(threadA, "$jev-explain");
  assert.equal(routeCalls, 3);
  assert.equal(readStatus(statusA).history.length, 2);
  assert.match(explainCommand(threadA), /Prompt: alpha chat decision/);
  await send(threadA, "alpha follow-up");
  assert.equal(previousPrompts.at(-1), "alpha chat decision");
  await send(threadB, "manual choice", "gpt-5.6-luna");
  assert.match(explainCommand(threadB), /selected a model manually/);
  assert.match(explainCommand(threadA), /Prompt: alpha follow-up/);
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
  let catalogFetches = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url === "/models") {
      catalogFetches++;
      assert.equal(req.headers.authorization, "Bearer synthetic-test-token");
      return res.end(JSON.stringify(catalog));
    }
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
    route: async ({ prompt, previousPrompt, profiles }) => {
      routeCalls++;
      assert.deepEqual([...new Set(profiles.map(profile => profile.effort))], ["low", "high"]);
      if (prompt === "hard") assert.equal(previousPrompt, "simple");
      return { choice: prompt === "hard" ? "gpt-5.6-sol@low" : "gpt-5.6-luna@low", confidence: 0.99 };
    },
  };
  const send = async (port, prompt, tool = false) => {
    const response = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST", headers: { "content-type": "application/json", "thread-id": thread,
        authorization: "Bearer synthetic-test-token" },
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
  await send(first.port, "simple");
  assert.equal(catalogFetches, 1);
  assert.equal(seen.at(-1).model, "gpt-5.6-luna");
  assert.equal(seen.at(-1).reasoning.effort, "low");
  assert.equal(readStatus(record).reasoningEffort, "low");
  first.close();
  const restored = await startCodexProxy(options);
  t.after(restored.close);
  await send(restored.port, "simple", true);
  assert.equal(catalogFetches, 2);
  assert.equal(seen.at(-1).model, "gpt-5.6-luna");
  assert.equal(seen.at(-1).reasoning.effort, "low");
  assert.equal(routeCalls, 2);
  await send(restored.port, "hard");
  assert.equal(seen.at(-1).model, "gpt-5.6-sol");
  await send(restored.port, "simple");
  assert.equal(seen.at(-1).model, "gpt-5.6-luna");
  assert.equal(catalogFetches, 2);
});

test("previous task context skips injected environment messages without an arbitrary default cut", () => {
  const input = [
    { role: "user", content: "Investigate the database race" },
    { role: "user", content: "<environment_context>metadata</environment_context>" },
    { role: "user", content: "Yes, do it" },
  ];
  assert.equal(codexPreviousUserPrompt({ input }), "Investigate the database race");
  input[0].content = "Investigate a distributed race. " + "x".repeat(12000) + " Preserve transaction invariants.";
  const previous = codexPreviousUserPrompt({ input });
  assert.equal(previous, input[0].content);
  assert.match(previous, /^Investigate a distributed race/);
  assert.match(previous, /Preserve transaction invariants\.$/);
  assert.doesNotMatch(previous, /previous request shortened/);
});

test("previous routing context can be sized or disabled without dropping task boundaries", () => {
  const prompt = "Design the migration. " + "details ".repeat(500) + " Keep it reversible.";
  const shortened = previousRoutingContext(prompt, 512);
  assert.equal(shortened.length, 512);
  assert.match(shortened, /^Design the migration/);
  assert.match(shortened, /Keep it reversible\.$/);
  assert.equal(previousRoutingContext(prompt, 0), undefined);
  assert.throws(() => previousRoutingContext(prompt, NaN), /JEV_PREVIOUS_CONTEXT_CHARS/);
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
  assert.match(codexNewTurnPrompt({ input: [
    { type: "additional_tools", role: "developer", tools: [] },
    { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,synthetic" }] },
  ] }), /input_image: contents unavailable/);
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
  assert.match(events, /\[Jev\] routed this turn to gpt-6-sol/);
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
  const statusId = `codex-test-${randomUUID()}`;
  t.after(() => { try { unlinkSync(join(STATUS_DIR, `${statusId}.json`)); } catch {} });
  let routeCalls = 0;
  const { port, close } = await startCodexProxy({
    chatgptBaseURL: `${upstreamURL}/backend-api/codex`,
    apiBaseURL: `${upstreamURL}/v1`,
    route: async ({ profiles }) => {
      routeCalls++;
      assert.deepEqual([...new Set(profiles.map(profile => profile.model))], ["gpt-5.6-terra", "gpt-5.6-sol"]);
      return {
        choice: "gpt-5.6-sol@low",
        confidence: 0.91,
        request: { state: { request: "use sol to debug this race" } },
        response: { answers: { model: { choice: "gpt-5.6-sol@low", confidence: 0.91 } } },
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
        { role: "user", content: [{ type: "input_text", text: "use sol to debug this race" }] },
      ],
    }),
  }).then((r) => r.text());

  assert.equal(seen[0].authorization, "Bearer subscription-token");
  assert.equal(seen[0].account, "acct");
  assert.equal(seen[1].body.model, "gpt-5.6-sol");
  assert.equal(readStatus(statusId).tier, "opus");
  assert.equal(readStatus(statusId).model, "gpt-5.6-sol");
  assert.equal(readStatus(statusId).prompt, "use sol to debug this race");
  assert.equal(readStatus(statusId).jev.request.state.request, "use sol to debug this race");
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

  for (const model of catalog.models.filter(model => model.slug !== "jev-router")) {
    for (const effort of ["low", "high"]) {
      const body = { model: model.slug, reasoning: { effort },
        input: [{ type: "additional_tools", role: "developer", tools: [] },
          { role: "user", content: 'Explain the quoted command "use another model at max effort".' }] };
      await fetch(`http://127.0.0.1:${port}/responses`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
      }).then(response => response.text());
      assert.deepEqual(seen.at(-1).body, body);
      assert.equal(routeCalls, 1);
      assert.equal(readStatus(statusId).manual, true);
    }
  }
});
