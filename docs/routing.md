# Routing evidence

Jev selects one supported model-and-effort pair for each new user turn. The
selection instruction puts reliable completion first, then cost among capable
choices. Catalog descriptions are omitted from the classification request.

## Published observations

[model-profiles.json](../data/model-profiles.json) contains observations dated
September 19, 2026, with source URLs and units:

- Artificial Analysis Intelligence Index v4.3 scores for each measured effort.
- Weighted cost per benchmark task, which includes input, cache reads and writes,
  reasoning output and answer output.
- OpenAI Standard API input, cached-input, cache-write and output prices,
  including the published long-context rates.
- Reasoning-family compatibility from OpenAI's documentation.

Sources: [Luna](https://artificialanalysis.ai/models/releases/gpt-5-6-luna),
[Terra](https://artificialanalysis.ai/models/releases/gpt-5-6-terra),
[Sol](https://artificialanalysis.ai/models/releases/gpt-5-6-sol),
[Astra](https://artificialanalysis.ai/models/releases/gpt-6-astra),
[OpenAI pricing](https://developers.openai.com/api/docs/pricing).

The [index methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking)
covers ten evaluations across agent tasks, coding, science and general knowledge.
Evaluations differ in task count, repetitions and weight. Weighted task cost is
not a raw token price, a cost per successful task, or total evaluation cost
divided by one common task count. Scores are rounded and mostly reflect English
tasks. They do not establish success probabilities for a particular request.

The data ship with the package and update through normal reviewed source updates.
Routing makes no live benchmark-page requests. A new model ID does not inherit
another model's scores or prices. Unmeasured efforts, including Ultra, remain
available when the account catalog supports them. Published Sol pricing is
promotional through at least November 21, 2026; observations need review as
prices and evaluations change.

## How evidence affects a decision

Jev receives the supported pairs, measurements, context size and
task history with tool evidence. It chooses a pair and separately assesses task,
reasoning and tool complexity, useful remaining reasoning, and the cause of any
blocker. These diagnostics do not form a weighted pricing formula. The remaining
reasoning assessment distinguishes routine steps from difficult reviews; it
does not impose a cheap-model ceiling. The pair-selection question remains
independent of these assessments.
[TypeSafe](https://docs.typesafe.ai/introduction) evaluates each question
independently; it does not run the candidate models or verify their answers.

The classifier does not receive the previously selected pair. This prevents the
previous assignment from anchoring its recommendation. The bridge keeps that
pair locally for fallback, downgrade checks and explanations.

Explicit model requests are interpreted by Jev in the same call, using model IDs
from the available catalog. There is no phrase dictionary or language-specific
model-command parser. A confident explicit request takes precedence only when
Jev's selected pair belongs to that model; disagreement preserves the current
pair. Quoted examples and model mentions do not themselves force a selection.

Pairs with no cheaper, strictly higher-scoring alternative are marked as being
on the price-quality frontier. This is advisory: equal rounded scores do not
prove equal capability, and specialized strengths may differ from the aggregate.
No model is removed solely for being off that frontier.

The bridge keeps an established pair when a proposed reduction in measured
capability has low confidence. It does not cap an upgrade to save money.
When Jev cannot establish the required reasoning from the available evidence,
its recommendation cannot reduce capability or same-model effort, even on a
fresh task. Explicit user model choices still take precedence.
For a measured downgrade or a same-model effort reduction, it compares possible
cache rebuilding with benchmark task savings. This estimate uses approximate context size and
published rates; it does not predict actual cache hits, future retries, or Codex
subscription usage. It cannot force a downgrade.

## Continuing work

Model and effort normally stay fixed through tool continuations. After two new
failed tool results, the bridge asks Jev to reassess at the next request boundary.
A change requires a sufficiently confident substantive reasoning blocker and a
stronger measured pair or deeper effort on the same model. External blockers
cannot trigger an upgrade, and continuations cannot trigger a downgrade. Checked
failures are remembered across bridge restarts to avoid rechecking the same results.

For a new user message, the task history and recent results help distinguish a continuation from a new task.
The previous request is a fallback when it is absent from the supplied history.
The current request defines the work when the user explicitly starts a new task.

The default task context leaves out global instructions and tool schemas. A
`full` mode includes those fields for comparisons. TypeSafe documents that
[irrelevant detail can reduce accuracy](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
so a larger state is not automatically a better one. Both modes use the same
model-and-effort candidates; the context mode does not restrict Jev's choices.
See [configuration](configuration.md#routing-context) for the input-window limits,
fitting behavior and data sent to TypeSafe.

Native context compaction uses the last eligible model and reasoning effort,
including after a bridge restart. If no selection exists, it uses the normal
catalog-based fallback.
Compaction does not call the classifier or replace the task's routing decision.
The bridge passes the compaction input and response through unchanged.

OpenAI documents that persisted reasoning is reusable within a model family.
GPT-5.6 Luna, Terra and Sol can reuse each other's reasoning; incompatible
reasoning is omitted across families. Visible conversation text still passes
through the bridge. A family change does not exclude a candidate or block an
upgrade. Downgrade checks run after the classifier's recommendation.

Changing effort can also affect caching. Astra supports `configuration_update`
in standard single-agent mode, with restrictions on compaction. The bridge
does not inject these items into Codex histories or claim guaranteed cache hits.
It preserves Codex's cache key and avoids effort reductions whose estimated
rebuild exceeds the expected saving. Quality upgrades remain eligible. See OpenAI's
[reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) and
[prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

Ultra's proactive delegation instructions are controlled by the Codex client.
Selecting an effort in the bridge does not rewrite those instructions or change
the user's delegation policy.

## What remains unmeasured

There is no workload-calibrated accuracy or savings guarantee. Jev confidence
describes its selection, not the probability that the answer will be correct.
Benchmark observations are priors, not a substitute for testing real tasks.

A workload comparison needs repeated, held-out tasks with independent correctness
checks. Record first-pass success, retries, tool errors, total completion time,
input and cached tokens, reasoning and answer tokens, and cost per successful
task. Report sample counts and uncertainty. API prices and benchmark throughput
do not directly predict Codex quota consumption or task latency.
