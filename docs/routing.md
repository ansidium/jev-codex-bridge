# Routing evidence

Jev selects one supported model-and-effort pair for each new user turn and
reassesses when task evidence changes during a continuation. The
selection instruction puts reliable completion first, then cost among capable
choices. Catalog descriptions are omitted from the classification request.

## Published observations

[model-profiles.json](../data/model-profiles.json) contains observations dated
September 23, 2026, with source URLs and units:

- Artificial Analysis Intelligence Index v4.3.2 scores for each measured effort.
- AA-Briefcase v1.1 Elo for professional deliverables and Terminal-Bench 4.0
  success rates (0 to 1), retained in the source snapshot for research.
- Weighted cost per benchmark task, which includes input, cache reads and writes,
  reasoning output and answer output.
- OpenAI Standard API input, cached-input, cache-write and output prices,
  including the published long-context rates.
- Reasoning-family compatibility from OpenAI's documentation.

Sources: [GPT-6 Luna](https://artificialanalysis.ai/models/releases/gpt-6-luna),
[GPT-6 Sol](https://artificialanalysis.ai/models/releases/gpt-6-sol),
[GPT-5.6 Luna](https://artificialanalysis.ai/models/releases/gpt-5-6-luna),
[Terra](https://artificialanalysis.ai/models/releases/gpt-5-6-terra),
[GPT-5.6 Sol](https://artificialanalysis.ai/models/releases/gpt-5-6-sol),
[Astra](https://artificialanalysis.ai/models/releases/gpt-6-astra),
[OpenAI pricing](https://developers.openai.com/api/docs/pricing).

At Max, GPT-6 Sol scores 48 versus 47 for GPT-5.6 Sol; both Luna generations
round to 37. Individual evaluations differ, so this does not establish that the
new generation wins every task. Standard input/output prices per million tokens
are $2/$10 for [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)
and $0.10/$0.50 for [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).
AA has not published complete weighted task costs for these two releases in this
snapshot. Those fields are omitted, and neither model establishes price-quality
dominance using token prices alone. Previous-generation observations remain for
manual selections and account catalogs that still expose those models.
The classifier receives the aggregate intelligence score and measured task cost.
Individual evaluation results remain in the source data and diagnostics. Feeding
all of their different scales into the same choice biased a controlled comparison
toward Astra even on routine tasks; no task-word rules compensate for that bias.

The [index methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking)
covers ten evaluations across agent tasks, coding, science and general knowledge.
Evaluations differ in task count, repetitions and weight. Weighted task cost is
not a raw token price, a cost per successful task, or total evaluation cost
divided by one common task count. Scores are rounded and mostly reflect English
tasks. They do not establish success probabilities for a particular request.

The data ship with the package and update through normal reviewed source updates.
Routing makes no live benchmark-page requests. A new model ID does not inherit
another model's scores or prices. Unmeasured efforts, including Ultra, remain
available when the account catalog supports them. Published GPT-5.6 Sol pricing is
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

The commentary line uses the catalog's model label in lowercase, for example:
`[jev] keeping gpt-6 astra (high · confidence 20%)`.
`selected` marks an initial choice, `keeping` preserves an established pair,
`switched to` changes the model or effort, and `fallback to` means Jev was
unavailable. Confidence is the classifier's recommendation confidence, including
when policy keeps a different pair; it is not answer accuracy. Unavailable
confidence is shown as `n/a`. Full policy reasons remain in `$jev-explain`.

For a guaranteed model and effort, use Codex's model picker or CLI options.
Manual selections pass through without classification. While Jev Router is
selected, the prompt is evidence for automatic routing, including any stated
preferences; it is not a model-switching command protocol. Text cannot bypass
the confidence, missing-evidence or cache guards. There is no phrase parser or
separate inferred model override that can conflict with the selected pair.

Pairs with no cheaper, strictly higher-scoring alternative are marked as being
on the price-quality frontier. This is advisory: equal rounded scores do not
prove equal capability, and specialized strengths may differ from the aggregate.
No model is removed solely for being off that frontier.

The bridge keeps the current pair, including the cold-start fallback, when a
proposed reduction or an unproven capability change has low confidence. It does
not cap an upgrade to save money. Effort order comes from the account catalog.
For an unmeasured effort, measured levels of the same model bound a comparison:
if a lower effort already exceeds the current pair, a higher effort can upgrade.
This does not assign the unmeasured level a benchmark score or task cost.
Overlapping bounds leave the cross-model comparison unknown, so it receives
the same protection as a downgrade. Equal rounded scores do not prove an upgrade.
When Jev cannot establish the required reasoning from the available evidence,
its recommendation cannot reduce capability or same-model effort, even on a
fresh task. Manual model selections still take precedence.
For a protected change, the bridge compares rebuilding an observed cached prefix
with benchmark task savings. Successful Responses completions supply actual
input, cache-read, cache-write, output and reasoning-token counts when available.
Only cache reads and writes from the last completed request count, and only when
its entire input prefix, instructions, tools, model, effort and other request
settings remain unchanged. Per-turn client metadata is excluded from that check.
The persisted evidence contains a hash and item count, not another copy of input.
Compaction or a changed prefix invalidates reuse; the bridge does not estimate
partially reusable prefixes from JSON length. Missing usage is unknown, not a
measured zero or evidence of a hot cache. Failed and interrupted responses do
not establish cache measurements, and older responses cannot overwrite newer ones.
The estimate uses published rates; it does not predict future cache hits, cache
expiry, retries or Codex subscription usage. It cannot force a downgrade.
If rebuilding that measured prefix costs more than retaining it but task costs
are unpublished, the current pair is retained: missing costs cannot establish
savings. Without measured reuse, missing task costs alone do not veto a change.
Quality upgrades remain eligible regardless of cache cost.

## Continuing work

The bridge reassesses changed user messages and tool evidence at the next
Responses request boundary. Successful tools can reveal a difficult problem,
and a new instruction can change the work without a tool failure. There is no
error-word parser or failure-count threshold. Identical evidence reuses the
accepted decision, including after a restart. Cancellation before forwarding
and rejected HTTP requests do not establish a decision; older responses cannot
overwrite newer requests.

During a continuation, reduced capability or same-model effort requires confident
assessments that substantive work is complete and only routine work remains.
The usual confidence, missing-evidence and cache checks still apply. Upgrades
do not require waiting for a failed approach. This protects unfinished work
without imposing a permanent model or effort floor. Reassessment adds a Jev
call when evidence changes, subject to the existing routing deadline.

For a new user message, the task history and recent results establish the scope
of the remaining authorized work. Approval or an instruction to continue inherits
unfinished work. An interruption also includes work that must resume after the
reply. Explicit pauses, cancellations and new tasks change that scope; completed
earlier work does not add difficulty. A short correctness question can still be hard.
The previous request is a fallback when it is absent from the supplied history.

Pair selection and the remaining-work assessments share the same scope rule.
On a new turn, the current request supersedes conflicting earlier instructions.
During a continuation, later user messages and actual outcomes update the scope
of the opening request. Relevant facts and constraints stay in the evidence;
paused, cancelled or replaced work does not contribute its old difficulty.
This does not relax confidence or cache checks or assign models to particular
phrases.

The default task context leaves out global instructions and tool schemas. A
`full` mode includes those fields for comparisons. TypeSafe documents that
[irrelevant detail can reduce accuracy](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
so a larger state is not automatically a better one. Both modes use the same
model-and-effort candidates; the context mode does not restrict Jev's choices.
See [configuration](configuration.md#routing-context) for the input-window limits,
fitting behavior and data sent to TypeSafe.

Native context compaction uses the last eligible model, including after a bridge
restart. If no selection exists, it uses the normal catalog-based fallback.
Compaction does not call the classifier or replace the task's routing decision.
This covers compaction metadata on `/responses` and the standalone
`/responses/compact` endpoint. The former retains the selected reasoning effort;
the latter does not receive an added reasoning parameter. The bridge preserves
the compaction input and response, including opaque state, as required by the
[compaction contract](https://developers.openai.com/api/docs/guides/compaction).
Subsequent changed evidence can be reassessed. An unchanged `turn_id` identifies
a continuation even if its last user-role message is now a compaction summary;
the original request and continuation downgrade checks still apply.
Turn identity is saved with automatic and manual selections and restored after
restarts. Clients without turn metadata use the existing message/tool boundary.

OpenAI documents that persisted reasoning is reusable within a model family.
GPT-5.6 Luna, Terra and Sol can reuse each other's reasoning; incompatible
reasoning is omitted by the API across families. The bridge preserves the full
input, including encrypted items. A family change does not exclude a candidate or block an
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

A September 23, 2026 comparison against the preceding bridge revision tested
eight tasks twice per version, checking generated answers independently. Both
versions passed 16/16, including counterexamples for unsafe concurrency and
generated interval-subtraction code checked on 250 inputs per answer. The
preceding version chose Astra 16 times; the revised selection chose Astra 9,
Sol 6 and Luna 1 time. This small sample supports retaining the simpler benchmark
input; it does not establish a general accuracy, latency or savings guarantee.

A workload comparison needs repeated, held-out tasks with independent correctness
checks. Record first-pass success, retries, tool errors, total completion time,
input and cached tokens, reasoning and answer tokens, and cost per successful
task. Report sample counts and uncertainty. API prices and benchmark throughput
do not directly predict Codex quota consumption or task latency.
