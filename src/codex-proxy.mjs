import http from "node:http";
import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { availableTiers, shouldUseExactModel, THRESHOLDS, CODEX_GUIDANCE } from "./config.mjs";
import { askJev } from "./router.mjs";
import { decide } from "./policy.mjs";
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
export function codexModels(models = new Map()) {
  const available = [...models.values()]
    .filter((model) => model.slug !== CODEX_AUTO_MODEL && model.supported_in_api !== false)
    .map((model) => ({
      id: model.slug,
      tier: codexTierOf(model.slug),
      guidance: CODEX_GUIDANCE[codexTierOf(model.slug)],
      description: [
        model.display_name,
        model.description,
        model.context_window && `${model.context_window} context tokens`,
      ].filter(Boolean).join("; "),
    }))
    .filter((model) => model.tier);
  return available.length
    ? available
    : Object.keys(DEFAULT_MODELS).map((tier) => ({
        id: codexModelOf(tier),
        tier,
        guidance: CODEX_GUIDANCE[tier],
        description: codexModelOf(tier),
      }));
}

const modelForTier = (models, tier) =>
  models.find((model) => model.tier === tier)?.id ?? codexModelOf(tier);

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" || item?.type === "input_text")
    .map((item) => item.text)
    .join("\n");
};

const cleanPrompt = (text) =>
  text
    .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();

export const isCodexAuxiliaryPrompt = (prompt) =>
  /^Generate a concise, single-line task title\b/i.test(prompt);

/** User text that starts a new Codex turn, or null for tool continuations. */
export function codexNewTurnPrompt(body) {
  if (!Array.isArray(body?.input)) return null;
  if (!body.input.some((item) => item?.type === "additional_tools")) return null;
  for (const item of [...body.input].reverse()) {
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") return null;
    if (item?.role !== "user") continue;
    const prompt = cleanPrompt(textOf(item.content));
    if (prompt && !isCodexAuxiliaryPrompt(prompt)) return prompt;
  }
  return null;
}

export function codexConversationKey(body) {
  const stable =
    body?.prompt_cache_key ??
    body?.client_metadata?.["x-codex-turn-metadata"] ??
    `${body?.instructions ?? ""}|${textOf(body?.input?.find((item) => item?.role === "user")?.content)}`;
  return createHash("sha1").update(String(stable)).digest("hex").slice(0, 12);
}

export function codexPreviousUserPrompt(body) {
  return body?.input?.filter(item => item?.role === "user")
    .map(item => cleanPrompt(textOf(item.content)))
    .filter(prompt => prompt && !isCodexAuxiliaryPrompt(prompt)).at(-2)?.slice(-2000);
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
    description: "Jev picks the cheapest model that can complete each turn.",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    upgrade: null,
  });
  return catalog;
}

export function applyCodexTier(body, tier, models = new Map(), model = codexModelOf(tier)) {
  body.model = model;
  const info = models.get(model);
  const efforts = info?.supported_reasoning_levels?.map((level) => level.effort);
  if (body.reasoning?.effort && efforts?.length && !efforts.includes(body.reasoning.effort)) {
    body.reasoning.effort = info.default_reasoning_level;
  }
  return body;
}

/** The ordered catalog defines supported depths; the user's selection is a ceiling. */
export function applyCodexEffort(body, recommendation, modelInfo, ceiling = body.reasoning?.effort, ceilingModelInfo = modelInfo) {
  const levels = modelInfo?.supported_reasoning_levels?.map(level => level.effort) ?? [];
  const order = ceilingModelInfo?.supported_reasoning_levels?.map(level => level.effort) ?? levels;
  const limit = order.indexOf(ceiling ?? modelInfo?.default_reasoning_level);
  const permitted = levels.filter(level => order.includes(level) && order.indexOf(level) <= limit);
  if (ceiling && !levels.includes(ceiling) && permitted.length) {
    body.reasoning = { ...body.reasoning, effort: permitted.at(-1) };
  }
  if (permitted.includes(recommendation)) {
    body.reasoning = { ...body.reasoning, effort: recommendation };
  }
  return body;
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
  const models = new Map();

  const server = http.createServer((req, res) => {
    if (!authorize(req)) { res.writeHead(403).end(); return; }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let routing;
      if (req.method === "POST" && /\/responses(?:\?|$)/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          const requestStatusId = statusId || codexStatusId(
            req.headers["thread-id"] ?? body.client_metadata?.thread_id ?? body.prompt_cache_key,
          );
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          if (body.model === CODEX_AUTO_MODEL) {
            const key = codexConversationKey(body);
            const candidates = codexModels(models).filter((model) =>
              availableTiers().includes(model.tier),
            );
            const available = [...new Set(candidates.map((model) => model.tier))];
            // Restore Desktop's per-thread model after a service restart. Initial
            // instructions alone do not establish a previous model or its cache.
            const previous = states.get(key) ?? (!statusId && readStatus(requestStatusId));
            const priorModel = candidates.some(candidate => candidate.id === previous?.model) ? previous.model : null;
            const currentModel = priorModel ?? modelForTier(candidates, "opus");
            const current = codexTierOf(currentModel) ?? "opus";
            const prompt = codexNewTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt ?? "");
            let tier = current;
            let model = currentModel;
            let reasoningEffort = previous?.reasoningEffort;
            if (prompt && !explaining) {
              const contextTokens = Math.round(JSON.stringify(body.input).length / 4);
              const reasoningLevels = [...new Map(candidates.flatMap(candidate =>
                models.get(candidate.id)?.supported_reasoning_levels ?? []
              ).map(level => [level.effort, level])).values()];
              const jev = await route({ prompt, current: currentModel, contextTokens, models: candidates,
                previousPrompt: previous?.prompt ?? codexPreviousUserPrompt(body), reasoningLevels });
              const chosen = candidates.find((candidate) => candidate.id === jev?.choice);
              const decision = decide({
                prompt,
                jev: jev && { ...jev, choice: chosen?.tier },
                current,
                available,
                contextTokens,
                hasPriorModel: Boolean(priorModel),
              });
              tier = decision.tier;
              model =
                shouldUseExactModel(decision.reason, chosen?.tier, tier)
                  ? chosen.id
                  : tier === current
                    ? currentModel
                    : modelForTier(candidates, tier);
              reasoningEffort = jev?.reasoning?.confidence >= THRESHOLDS.minConfidence ? jev.reasoning.choice : undefined;
              routing = {
                prompt,
                tier,
                model,
                confidence: jev?.confidence ?? null,
                metrics: jev?.metrics ?? null,
                reason: decision.reason,
                jev: jev ? { request: jev.request, response: jev.response } : null,
                at: Date.now(),
              };
            }
            const effortCeiling = body.reasoning?.effort;
            applyCodexTier(body, tier, models, model);
            applyCodexEffort(body, reasoningEffort, models.get(model), effortCeiling, models.get(CODEX_AUTO_MODEL));
            if (routing) {
              routing.reasoningEffort = body.reasoning?.effort;
              states.set(key, { tier, model, prompt, reasoningEffort: routing.reasoningEffort });
              writeDecision(requestStatusId, routing);
              debug(`${key} ${current} -> ${tier} (${routing.reason}) | ${prompt.slice(0, 60)}`);
            }
          } else {
            const prompt = codexNewTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt ?? "");
            if (prompt && !explaining) {
              states.set(codexConversationKey(body), { model: body.model, prompt });
              writeStatus(requestStatusId, { manual: true, model: body.model, prompt, at: Date.now() });
            }
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`codex passthrough, could not process body: ${err.message}`);
        }
      }

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
                const catalog = addJevModel(JSON.parse(data.toString()));
                for (const model of catalog.models) models.set(model.slug, model);
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

          const inspectForDecision = routing && response.statusCode >= 200 && response.statusCode < 300;
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
