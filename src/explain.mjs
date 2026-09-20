const WIDTH = 33;
const row = (text = "") => `│ ${text.slice(0, WIDTH - 2).padEnd(WIDTH - 2)} │`;
const metric = (value) => (Number.isFinite(value) ? value.toFixed(2) : "n/a");
const wrapped = (label, value) => {
  const words = `${label}${value}`.replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  for (const word of words) {
    if (!lines.length || `${lines.at(-1)} ${word}`.length > WIDTH - 2) lines.push(word);
    else lines[lines.length - 1] += ` ${word}`;
  }
  return lines.map(row);
};

const decision = (reason = "") => {
  if (reason.includes("override")) return "prompt override";
  if (reason.includes("jev-unavailable")) return "Jev unavailable; held";
  if (reason.includes("low-confidence-no-downgrade")) return "low confidence; held";
  if (reason.includes("unknown-reasoning-no-downgrade")) return "insufficient task evidence; held";
  if (reason.includes("low-confidence-capped")) return "low confidence; capped";
  if (reason.includes("cache-rebuild")) return "cache cost estimate; held";
  if (reason.includes("continuation-no-")) return "continuation; held";
  if (reason.includes("unavailable")) return "nearest available tier";
  return "Jev recommendation";
};

export function formatExplanation(status) {
  if (!status) return "Jev Router: no routing decision has been recorded for this session.";
  if (status.manual) return "Jev Router: routing is paused because you selected a model manually.";

  const m = status.metrics ?? {};
  const request = status.jev?.request?.state;
  const answers = status.jev?.response?.answers;
  const recommendation = answers?.profile?.choice ?? answers?.model?.choice ?? answers?.model_tier?.choice ?? "unknown";
  const pair = Boolean(answers?.profile);
  return [
    `┌${"─".repeat(WIDTH)}┐`,
    row("Jev Router"),
    row(),
    row("Jev request"),
    ...wrapped("Prompt: ", status.prompt ?? "not recorded"),
    ...wrapped(`Current ${pair || answers?.model ? "model" : "tier"}: `, (status.previousModel ?? request?.session?.current_model ?? "unknown").toUpperCase()),
    ...((status.previousReasoningEffort ?? request?.session?.current_effort)
      ? [row(`Current effort: ${status.previousReasoningEffort ?? request.session.current_effort}`)] : []),
    row(`Context tokens: ${request?.session?.approximate_context_tokens ?? request?.session?.context_tokens ?? "unknown"}`),
    ...(request?.routing_context ? [row(`Routing context: ${request.routing_context.mode}`),
      row(`Context shortened: ${request.routing_context.shortened ? "yes" : "no"}`)] : []),
    row(),
    row("Jev response"),
    row(`Task complexity     ${metric(m.taskComplexity)}`),
    row(`Reasoning required  ${metric(m.reasoningRequired)}`),
    row(`Tool complexity     ${metric(m.toolComplexity)}`),
    row(`Context size        ${metric(m.contextSize)}`),
    ...(status.assessment?.reasoningGain ? wrapped("Reasoning value: ", status.assessment.reasoningGain.choice) : []),
    ...(status.assessment?.workStatus ? wrapped("Work status: ", status.assessment.workStatus.choice) : []),
    ...(status.trigger === "tool-failures" ? [row("Trigger: new tool failures")] : []),
    row(),
    ...wrapped(`Recommended ${pair ? "pair" : answers?.model ? "model" : "tier"}: `, recommendation.toUpperCase()),
    ...wrapped("Selected model: ", (status.model ?? status.tier ?? "unknown").toUpperCase()),
    ...(status.reasoningEffort ? [row(`Reasoning effort: ${status.reasoningEffort.toUpperCase()}`)] : []),
    ...(status.evidence ? [row(`Evidence: ${status.evidence.asOf}`),
      row(status.evidence.measurement ? `Index: ${status.evidence.measurement.intelligence}; $/task: ${status.evidence.measurement.costPerTaskUSD}` : "Benchmark: not measured")] : []),
    row(),
    row(`Confidence: ${status.confidence == null ? "n/a" : `${Math.round(status.confidence * 100)}%`}`),
    ...wrapped("Decision: ", decision(status.reason)),
    `└${"─".repeat(WIDTH)}┘`,
  ].join("\n");
}
