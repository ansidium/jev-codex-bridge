import http from "node:http";
import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { availableTiers, THRESHOLDS, previousRoutingContext } from "./config.mjs";
import { askJev } from "./router.mjs";
import { codexInputItems, codexRoutingContext, textForRouting as textOf } from "./routing-context.mjs";
import { decide } from "./policy.mjs";
import { codexProfiles, fallbackProfile, frontierProfiles, PROFILE_DATA } from "./profiles.mjs";
import { log } from "./log.mjs";
import { codexStatusId, readStatus, writeDecision, writeStatus } from "./status.mjs";

const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const API_BASE_URL = "https://api.openai.com/v1";
export const CODEX_AUTO_MODEL = "jev-router";
const DEFAULT_MODELS = {
  haiku: "gpt-5.6-luna",
  sonnet: "gpt-5.6-terra",
  opus: "gpt-5.6-sol",
  fable: "gpt-6-astra",
};
const MODEL_ENV = {
  haiku: "JEV_CODEX_FAST_MODEL",
  sonnet: "JEV_CODEX_BALANCED_MODEL",
  opus: "JEV_CODEX_STRONG_MODEL",
  fable: "JEV_CODEX_LONG_MODEL",
};

export const codexModelOf = (tier) => process.env[MODEL_ENV[tier]] ?? DEFAULT_MODELS[tier];

export function codexTierOf(model) {
  const configured = Object.keys(DEFAULT_MODELS).find((tier) => codexModelOf(tier) === model);
  if (configured) return configured;
  if (/(?:astra|fable|long)/i.test(model ?? "")) return "fable";
  if (/(?:sol|opus|strong|max|pro)/i.test(model ?? "")) return "opus";
  if (/(?:luna|haiku|fast|mini|nano)/i.test(model ?? "")) return "haiku";
  return /^gpt-/i.test(model ?? "") ? "sonnet" : null;
}

/** Exact GPT models in Codex's account catalog; configured ids are the cold-start fallback. */
export function codexModels(models = new Map(), responsesLite = false) {
  const excluded = new Set((process.env.JEV_CODEX_EXCLUDE_MODELS ?? "").split(",").map(id => id.trim()));
  const source = models.size ? [...models.values()] : Object.keys(DEFAULT_MODELS).map(tier => ({ slug: codexModelOf(tier) }));
  return source
    .filter((model) => model.slug !== CODEX_AUTO_MODEL && model.supported_in_api !== false &&
      model.visibility !== "hide" && !excluded.has(model.slug) &&
      (!responsesLite || model.use_responses_lite !== false))
    .map((model) => ({
      id: model.slug,
      tier: codexTierOf(model.slug),
    }));
}

const cleanPrompt = (text) =>
  text
    .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();

export const isCodexAuxiliaryPrompt = (prompt) =>
  /^Generate a concise, single-line task title\b/i.test(prompt);

/** User text that starts a new Codex turn, or null for tool continuations. */
export function codexNewTurnPrompt(body, explicitTurn = false) {
  const input = codexInputItems(body);
  if (!explicitTurn && typeof body?.input !== "string" && !input.some((item) => item?.type === "additional_tools")) return null;
  for (const item of [...input].reverse()) {
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") return null;
    if (item?.role !== "user") continue;
    const prompt = cleanPrompt(textOf(item.content));
    if (prompt && !isCodexAuxiliaryPrompt(prompt)) return prompt;
  }
  return null;
}

const turnMetadata = (body, headers) => {
  try { return JSON.parse(headers["x-codex-turn-metadata"] ?? body?.client_metadata?.["x-codex-turn-metadata"] ?? "{}"); }
  catch { return {}; }
};

export function codexConversationKey(body, headers = {}) {
  const metadata = turnMetadata(body, headers);
  const stable =
    headers["thread-id"] ?? body?.client_metadata?.thread_id ??
    metadata?.thread_id ?? metadata?.session_id ??
    body?.prompt_cache_key ??
    `${body?.instructions ?? ""}|${textOf(codexInputItems(body).find((item) => item?.role === "user")?.content)}`;
  return createHash("sha1").update(String(stable)).digest("hex").slice(0, 12);
}

export function codexPreviousUserPrompt(body) {
  return previousRoutingContext(codexInputItems(body).filter(item => item?.role === "user")
    .map(item => cleanPrompt(textOf(item.content)))
    .filter(prompt => prompt && !isCodexAuxiliaryPrompt(prompt)).at(-2));
}

export function addJevModel(catalog) {
  if (!Array.isArray(catalog?.models) || catalog.models.some((model) => model.slug === CODEX_AUTO_MODEL)) {
    return catalog;
  }
  const template =
    catalog.models.find((model) => model.slug === codexModelOf("sonnet")) ??
    catalog.models.find((model) => model.visibility === "list") ??
    catalog.models[0];
  if (!template) return catalog;
  catalog.models.unshift({
    ...template,
    slug: CODEX_AUTO_MODEL,
    display_name: "Jev Router",
    description: "Jev selects a model and reasoning effort for the task, with quality first.",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    upgrade: null,
  });
  return catalog;
}

export const upstreamFor = (
  headers,
  path = "",
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
) => /\/models(?:\?|$)/.test(path) || headers["chatgpt-account-id"] ? chatgptBaseURL : apiBaseURL;

export function jevDecisionEvents({ tier, model = codexModelOf(tier), confidence, reason, reasoningEffort }) {
  const detail = (confidence == null ? reason : `${reason}, confidence ${confidence.toFixed(2)}`) +
    (reasoningEffort ? `, effort ${reasoningEffort}` : "");
  const id = `jev-${randomUUID()}`;
  const text = reason.startsWith("jev-unavailable")
    ? `[Jev] unavailable; using ${model}. Add JEV_API_KEY=... to ~/.jev-router.env and restart jev-codex.`
    : `[Jev] routed this turn to ${model} (${detail}).`;
  const item = {
    type: "message",
    role: "assistant",
    id,
    phase: "commentary",
    content: [{ type: "output_text", text }],
  };
  const events = [
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: id, delta: text },
    { type: "response.output_item.done", item },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const debug = (line) => process.env.JEV_DEBUG && log(line);
const upstreamPath = (base, path) => `${new URL(base).pathname.replace(/\/$/, "")}${path}`;

export async function startCodexProxy({
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
  route = askJev,
  statusId = "",
  authorize = () => true,
} = {}) {
  const states = new Map();
  const revisions = new Map();
  const models = new Map();
  let catalogRequest;
  const rememberCatalog = catalog => {
    if (!Array.isArray(catalog?.models)) throw new Error("Invalid model catalog");
    addJevModel(catalog);
    models.clear();
    for (const model of catalog.models) models.set(model.slug, model);
    return catalog;
  };
  const ensureCatalog = headers => {
    if (models.size) return;
    // Desktop can reuse its own catalog after the bridge restarts. Fetch once
    // with the current account's auth instead of guessing supported efforts.
    return catalogRequest ??= (async () => {
      const response = await fetch(`${chatgptBaseURL.replace(/\/$/, "")}/models`, {
        headers: Object.fromEntries(["authorization", "chatgpt-account-id", "user-agent"]
          .filter(key => headers[key]).map(key => [key, headers[key]])),
        signal: AbortSignal.timeout(THRESHOLDS.jevDeadlineMs),
      });
      if (!response.ok) throw new Error(`Model catalog returned ${response.status}`);
      rememberCatalog(await response.json());
    })().catch(error => debug(`using cold-start defaults: ${error.message}`));
  };

  const server = http.createServer((req, res) => {
    if (!authorize(req)) { res.writeHead(403).end(); return; }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let routing;
      let remember;
      let announce = true;
      const compactEndpoint = /\/responses\/compact(?:\?|$)/.test(req.url ?? "");
      if (req.method === "POST" && (compactEndpoint || /\/responses(?:\?|$)/.test(req.url ?? ""))) {
        try {
          const body = JSON.parse(out.toString());
          const metadata = turnMetadata(body, req.headers);
          const latestUser = codexInputItems(body).findLast(item => item.role === "user" && cleanPrompt(textOf(item.content)));
          const latestPrompt = cleanPrompt(textOf(latestUser?.content));
          const requestStatusId = statusId || codexStatusId(
            req.headers["thread-id"] ?? body.client_metadata?.thread_id ?? metadata?.thread_id ?? metadata?.session_id ?? body.prompt_cache_key,
          );
          const isCompaction = compactEndpoint || metadata?.request_kind === "compaction";
          const isTurn = !isCompaction && (!metadata?.request_kind || metadata.request_kind === "turn") && !isCodexAuxiliaryPrompt(latestPrompt);
          const key = codexConversationKey(body, req.headers);
          const saved = readStatus(requestStatusId);
          const previous = isTurn || isCompaction ? states.get(key) ??
            ((!statusId || saved?.conversationKey === key) ? saved : null) : null;
          // An older response must not overwrite a newer request's decision.
          const revision = (revisions.get(key) ?? 0) + 1;
          if (isTurn) revisions.set(key, revision);
          const turnId = metadata?.turn_id;
          const sameTurn = turnId && (turnId === previous?.turnId ||
            // Older status files have only the decision time, not the turn id.
            (!previous?.turnId && metadata.turn_started_at_unix_ms > 0 && previous?.at >= metadata.turn_started_at_unix_ms));
          const prompt = isTurn && !sameTurn ? codexNewTurnPrompt(body, metadata?.request_kind === "turn") : null;
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          if (body.model === CODEX_AUTO_MODEL) {
            await ensureCatalog(req.headers);
            const responsesLite = req.headers["x-openai-internal-codex-responses-lite"] === "true";
            const candidates = codexModels(models, responsesLite).filter((model) =>
              model.tier !== "fable" || availableTiers().includes("fable"),
            );
            const contextTokens = Math.round(JSON.stringify(body.input ?? []).length / 4);
            const profiles = codexProfiles(candidates, models, body.reasoning?.effort, contextTokens);
            if (!profiles.length) {
              res.writeHead(503, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: { message: "No eligible models in the Codex catalog for this request.", type: "router_error" } }));
              return;
            }
            // Restore Desktop's per-thread model after a service restart. Initial
            // instructions alone do not establish a previous model or its cache.
            const priorModel = profiles.some(profile => profile.model === previous?.model) ? previous.model : null;
            const current = fallbackProfile(profiles, priorModel ?? codexModelOf("opus"), previous?.reasoningEffort);
            const explaining = latestPrompt.includes("<jev-explain>") || /^\$jev-explain\b/i.test(latestPrompt);
            const continuation = Boolean(previous && (sameTurn || !prompt));
            const routingPrompt = prompt ?? previous?.prompt;
            const conversation = codexRoutingContext(body, undefined, routingPrompt);
            const evidenceHash = createHash("sha256").update(JSON.stringify({ prompt: routingPrompt, conversation,
              effort: body.reasoning?.effort, profiles: profiles.map(profile => profile.id) })).digest("hex");
            const changed = evidenceHash !== previous?.evidenceHash || (turnId && !sameTurn);
            let selected = current;
            if (isTurn && routingPrompt && changed && !explaining) {
              const frontier = new Set(frontierProfiles(profiles).map(profile => profile.id));
              const options = profiles.map(profile => ({ ...profile, onFrontier: frontier.has(profile.id) }));
              const jev = await route({ prompt: routingPrompt, current, contextTokens, profiles: options,
                previousPrompt: previous?.prompt ?? codexPreviousUserPrompt(body), conversation, continuation });
              const decision = decide({ jev, current, profiles, contextTokens,
                hasPriorModel: Boolean(priorModel), continuation });
              selected = decision.profile;
              announce = !continuation || decision.changed;
              routing = {
                prompt: routingPrompt,
                turnId,
                conversationKey: key,
                evidenceHash,
                trigger: continuation ? "context-change" : "user",
                previousModel: current.model,
                previousReasoningEffort: current.effort,
                tier: selected.tier,
                model: selected.model,
                profile: selected.id,
                evidence: { asOf: PROFILE_DATA.asOf, benchmark: PROFILE_DATA.benchmark.name,
                  measurement: selected.benchmark ?? null },
                confidence: jev?.confidence ?? null,
                metrics: jev?.metrics ?? null,
                assessment: jev?.assessment ?? null,
                reason: decision.reason,
                jev: jev ? { request: jev.request, response: jev.response } : null,
                at: Date.now(),
              };
            }
            body.model = selected.model;
            if (!compactEndpoint && selected.effort) body.reasoning = { ...body.reasoning, effort: selected.effort };
            if (routing) {
              routing.reasoningEffort = body.reasoning?.effort;
              remember = () => {
                if (res.destroyed || revisions.get(key) !== revision) return;
                states.set(key, { model: selected.model, prompt: routing.prompt,
                  turnId: routing.turnId, reasoningEffort: routing.reasoningEffort, evidenceHash });
                writeDecision(requestStatusId, routing);
              };
              debug(`${key} ${current.id} -> ${selected.id} (${routing.reason}) | ${routing.prompt.slice(0, 60)}`);
            }
          } else {
            const explaining = latestPrompt.includes("<jev-explain>") || /^\$jev-explain\b/i.test(latestPrompt);
            if (isTurn && latestPrompt && !explaining) {
              remember = () => {
                if (res.destroyed || revisions.get(key) !== revision) return;
                const state = { model: body.model, prompt: latestPrompt, turnId, conversationKey: key, reasoningEffort: body.reasoning?.effort };
                states.set(key, state);
                writeStatus(requestStatusId, { ...state, manual: true, at: Date.now() });
              };
            }
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`codex passthrough, could not process body: ${err.message}`);
        }
      }

      if (res.destroyed) return;
      const base = upstreamFor(req.headers, req.url, chatgptBaseURL, apiBaseURL);
      const target = new URL(base);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: upstreamPath(base, req.url ?? "/"),
          method: req.method,
          headers,
        },
        (response) => {
          const responseHeaders = { ...response.headers };
          const isModels = req.method === "GET" && /\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels) {
            const body = [];
            response.on("data", (chunk) => body.push(chunk));
            response.on("end", () => {
              let data = Buffer.concat(body);
              try {
                const catalog = rememberCatalog(JSON.parse(data.toString()));
                data = Buffer.from(JSON.stringify(catalog));
                delete responseHeaders["content-length"];
              } catch (err) {
                debug(`could not extend Codex model catalog: ${err.message}`);
              }
              res.writeHead(response.statusCode, responseHeaders);
              res.end(data);
            });
            return;
          }

          const accepted = response.statusCode >= 200 && response.statusCode < 300;
          if (accepted) remember?.();
          const inspectForDecision = routing && accepted && announce;
          if (inspectForDecision) delete responseHeaders["content-length"];
          res.writeHead(response.statusCode, responseHeaders);
          if (!inspectForDecision) {
            response.pipe(res);
            return;
          }
          let pending = "";
          let inspected = false;
          response.on("data", (chunk) => {
            if (inspected) return void res.write(chunk);
            pending += chunk.toString();
            const end = pending.indexOf("\n\n");
            if (end < 0) return;
            const first = pending.slice(0, end + 2);
            res.write(first);
            const isSSE = /^(?:event|data):/m.test(first);
            if (isSSE) res.write(jevDecisionEvents(routing));
            debug(`codex decision display ${isSSE ? "inject" : "skip"}`);
            res.write(pending.slice(end + 2));
            pending = "";
            inspected = true;
          });
          response.on("end", () => {
            if (pending) {
              debug("codex decision display skip");
              res.write(pending);
            }
            res.end();
          });
        },
      );
      res.once("close", () => { if (!res.writableEnded) upstream.destroy(); });
      upstream.on("error", (err) => {
        debug(`codex upstream error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "proxy_error" } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
