import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { codexRoutingContext, contextExcerpt, conversationExcerpt, fitRoutingState } from "../src/routing-context.mjs";
import { askJev } from "../src/router.mjs";

test("task context carries constraints, failed tools, summaries and media indicators", () => {
  const body = {
    instructions: "Global assistant instructions",
    tools: [{ type: "function", name: "shell", description: "Tool schema" }],
    input: [
      { role: "user", content: "Preserve transaction invariants. " + "details ".repeat(2000) + "Keep rollback available." },
      { role: "user", content: "AGENTS.md: never discard an unfinished transaction." },
      { role: "assistant", content: [{ type: "output_text", text: "The first repair did not solve the race." }] },
      { type: "function_call", name: "shell", call_id: "test-1", arguments: "run recovery tests" },
      { type: "function_call_output", call_id: "test-1", output: "FAILED: committed data lost after restart" },
      { type: "reasoning", encrypted_content: "opaque-secret", summary: [{ type: "summary_text", text: "Recovery ordering is unresolved." }] },
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,synthetic-secret" }, { type: "input_text", text: "Fix this too." }] },
      { role: "user", content: "<environment_context>injected environment</environment_context>" },
      { type: "additional_tools", tools: [{ name: "extra_tool", description: "Extra schema" }] },
    ],
  };
  const task = codexRoutingContext(body, "task");
  for (const evidence of [body.input[0].content, "AGENTS.md", "first repair", "test-1", "committed data lost", "Recovery ordering", "input_image", "Fix this too."]) {
    assert(task.includes(evidence), evidence);
  }
  assert.doesNotMatch(task, /opaque-secret|synthetic-secret|injected environment|Global assistant|Extra schema|Tool schema/);
  const full = codexRoutingContext(body, "full");
  assert.match(full, /Global assistant/);
  assert.match(full, /Extra schema/);
  assert.match(full, /Tool schema/);
  assert.doesNotMatch(full, /opaque-secret|synthetic-secret/);
  assert.equal(codexRoutingContext(body, "previous"), "");
  const noDuplicate = codexRoutingContext({ input: [
    { role: "user", content: "Continue" },
    { type: "function_call_output", call_id: "previous", output: "Still failing" },
    { role: "user", content: "Continue" },
  ] }, "task", "Continue");
  assert.equal((noDuplicate.match(/Continue/g) ?? []).length, 1);
  assert.match(noDuplicate, /Still failing/);
});

test("task context excludes system and developer scaffolding by role at any position", () => {
  const input = [
    { role: "system", content: "System instructions" },
    { role: "developer", content: "Global Codex instructions and tool descriptions" },
    { role: "user", content: "AGENTS.md: preserve the recovery log." },
    { role: "user", content: "Diagnose the failed transaction." },
    { type: "function_call_output", call_id: "read-rules", output: "Repository constraint: keep the public API stable." },
    { role: "assistant", content: "The transaction is still unresolved." },
    { role: "developer", content: "Reinjected skill catalog and app instructions" },
    { role: "user", content: "Continue." },
  ];
  const body = { input };
  const original = structuredClone(body);
  const task = codexRoutingContext(body, "task", "Continue.").split("\n").map(JSON.parse);
  assert.deepEqual(task.map(entry => entry.text ?? entry.output), input.slice(2, 6).map(item => item.content ?? item.output));
  const full = codexRoutingContext(body, "full").split("\n").map(JSON.parse);
  assert.deepEqual(full.map(entry => entry.text ?? entry.output), input.map(item => item.content ?? item.output));
  assert.deepEqual(body, original);
});

test("window fitting preserves Unicode and both ends while keeping the current request", () => {
  const history = "Original invariant: " + '\u042f\ud83d\ude80"\\\n'.repeat(5000) + "Latest failure: recovery is still broken.";
  const excerpt = contextExcerpt(history, 1024);
  assert(Buffer.byteLength(JSON.stringify(excerpt)) <= 1024);
  assert.match(excerpt, /^Original invariant/);
  assert.match(excerpt, /Latest failure: recovery is still broken\.$/);
  assert.match(excerpt, /omitted to fit Jev/);
  assert.doesNotMatch(excerpt, /\ufffd/);
  assert(excerpt.isWellFormed());
  const state = { request: "Fix the remaining failure", conversation: history, session: { current_model: "test" } };
  const fitted = fitRoutingState(state, 2048, "task");
  assert.equal(fitted.request, state.request);
  assert.equal(fitted.routing_context.shortened, true);
  assert.match(fitted.conversation, /Original invariant/);
  assert.match(fitted.conversation, /recovery is still broken/);
  assert(Buffer.byteLength(JSON.stringify(fitted)) <= 2048);
  assert.equal(state.conversation, history);
  const small = fitRoutingState({ request: "Continue", conversation: "A failed check" }, 2048, "task");
  assert.equal(small.conversation, "A failed check");
  assert.equal(small.routing_context.shortened, false);
});

test("fitting retains interior failures, middle constraints and intact source records", () => {
  const log = "Test run start\n" + "Passed ordinary check\n".repeat(2500) +
    "FAILED: checkpoint discarded an acknowledged transaction\nExpected 42; actual 41\n" +
    "Passed ordinary check\n".repeat(2500) + "Test run finished";
  const excerpt = contextExcerpt(log, 3000);
  assert.match(excerpt, /FAILED: checkpoint discarded an acknowledged transaction/);
  assert.match(excerpt, /Expected 42; actual 41/);
  assert.match(excerpt, /Test run start/);
  assert.match(excerpt, /Test run finished/);
  assert(Buffer.byteLength(JSON.stringify(excerpt)) <= 3000);
  const body = { input: [
    { role: "user", content: "Repair crash recovery without data loss." },
    ...Array.from({ length: 80 }, (_, i) => ({ role: "assistant", content: `Routine result ${i}: ` + "ok ".repeat(500) })),
    { role: "user", content: "Never acknowledge writes before durability is established." },
    { type: "function_call", name: "recovery_tests", call_id: "middle-test", arguments: "check invariants" },
    { type: "function_call_output", call_id: "middle-test", output: log },
    { role: "user", content: "Continue the repair." },
  ] };
  const conversation = codexRoutingContext(body);
  const fitted = conversationExcerpt(conversation, 7000);
  const entries = fitted.split("\n").map(line => JSON.parse(line));
  assert.match(fitted, /Never acknowledge writes/);
  assert.match(fitted, /FAILED: checkpoint discarded/);
  const failure = entries.find(entry => entry.type === "function_call_output");
  assert.equal(failure.name, "recovery_tests");
  assert.equal(failure.call_id, "middle-test");
  assert.equal(failure.source_index, 83);
  assert(Buffer.byteLength(JSON.stringify(fitted)) <= 7000);
  assert.doesNotMatch(fitted, /\ufffd/);
  assert.equal(body.input[83].output, log);
});

test("Jev size rejections retry with more compact evidence; other validation failures do not", async t => {
  const seen = [];
  let responseStatus = 400;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.setHeader("content-type", "application/json");
      if (responseStatus) {
        res.statusCode = responseStatus;
        responseStatus = 0;
        return res.end(JSON.stringify({ detail: { error_type: res.statusCode === 400 ? "max_tokens_exceeded" : "invalid_question" } }));
      }
      res.end(JSON.stringify({ model: "jev-test", answers: {
        profile: { choice: "test@low", confidence: 0.95 },
        requested_model: { choice: "test", confidence: 0.99 },
        task_complexity: { score: 8 }, reasoning_required: { score: 8 }, tool_complexity: { score: 7 },
      }, usage: { input_tokens: 100, output_tokens: 10 } }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const vars = { JEV_API_KEY: "synthetic-test-key", TYPESAFE_BASE_URL: `http://127.0.0.1:${server.address().port}`, JEV_ROUTING_CONTEXT: "task" };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const current = { id: "test@low", model: "test", effort: "low", contextWindow: 100000 };
  const args = { prompt: "Continue fixing the failed recovery", current, profiles: [current], contextTokens: 50000,
    previousPrompt: "Keep transaction invariants", conversation: "Start of task. " + "large tool result\n".repeat(20000) + " Unresolved failure at the end." };
  const result = await askJev(args);
  assert.equal(result.choice, "test@low");
  assert.equal(result.assessment.requestedModel, undefined);
  assert.equal(result.response.answers.requested_model.choice, "test");
  assert.equal(seen[0].questions.requested_model, undefined);
  assert.equal(seen.length, 2);
  assert(seen[1].state.conversation.length < seen[0].state.conversation.length);
  assert.equal(seen[1].state.request, args.prompt);
  assert.match(seen[1].state.conversation, /Start of task/);
  assert.match(seen[1].state.conversation, /Unresolved failure at the end/);
  assert.equal(result.request.state.routing_context.shortened, true);
  responseStatus = 422;
  assert.equal(await askJev(args), null);
  assert.equal(seen.length, 3);
  process.env.JEV_ROUTING_CONTEXT = "previous";
  await askJev(args);
  assert.equal(seen.at(-1).state.conversation, undefined);
  assert.equal(seen.at(-1).state.previous_request, args.previousPrompt);
  await t.test("the prior model and effort cannot anchor the classification request", async () => {
    process.env.JEV_ROUTING_CONTEXT = "task";
    const other = { id: "other@deep", model: "other", effort: "deep", reasoningFamily: "other-family", contextWindow: 200000 };
    const neutral = { ...args, profiles: [current, other], conversation: "The crash recovery failure is unresolved." };
    await askJev(neutral);
    const first = seen.at(-1);
    assert.deepEqual(first.state.session, { approximate_context_tokens: 50000 });
    await askJev({ ...neutral, current: other });
    assert.deepEqual(seen.at(-1), first);
  });
});
