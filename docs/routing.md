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

Jev receives the supported pairs, measurements, context size, current pair and
previous request. It chooses a pair and separately scores task, reasoning and
tool complexity. These scores are diagnostics, not a weighted pricing formula.
[TypeSafe](https://docs.typesafe.ai/introduction) evaluates each question
independently; it does not run the candidate models or verify their answers.

Pairs with no cheaper, strictly higher-scoring alternative are marked as being
on the price-quality frontier. This is advisory: equal rounded scores do not
prove equal capability, and specialized strengths may differ from the aggregate.
No model is removed solely for being off that frontier.

The bridge keeps an established pair when a proposed reduction in measured
capability has low confidence. It does not cap an upgrade to save money.
For a measured downgrade to another model, it compares possible cache rebuilding
with benchmark task savings. This estimate uses approximate context size and
published rates; it does not predict actual cache hits, future retries, or Codex
subscription usage. It cannot force a downgrade.

## Continuing work

Model and effort stay fixed through tool continuations. For a new user message,
the previous request helps distinguish a continuation from a new task.

OpenAI documents that persisted reasoning is reusable within a model family.
GPT-5.6 Luna, Terra and Sol can reuse each other's reasoning; incompatible
reasoning is omitted across families. Visible conversation text still passes
through the bridge. Jev is instructed to avoid a family change for small savings
when unfinished work depends on earlier reasoning.

Changing effort can also affect caching. Astra supports `configuration_update`
in standard single-agent mode, with restrictions on compaction. The bridge
does not inject these items into Codex histories. See OpenAI's
[reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) and
[prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

## What remains unmeasured

There is no workload-calibrated accuracy or savings guarantee. Jev confidence
describes its selection, not the probability that the answer will be correct.
Benchmark observations are priors, not a substitute for testing real tasks.

A workload comparison needs repeated, held-out tasks with independent correctness
checks. Record first-pass success, retries, tool errors, total completion time,
input and cached tokens, reasoning and answer tokens, and cost per successful
task. Report sample counts and uncertainty. API prices and benchmark throughput
do not directly predict Codex quota consumption or task latency.
