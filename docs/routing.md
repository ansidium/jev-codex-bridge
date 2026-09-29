# Routing

Jev selects a supported model-and-effort pair for the remaining authorized work.
The bridge applies confidence, continuation and cache safeguards before
forwarding the Codex request.

## Selection

The current request, relevant history and tool results define the work.
Approval or "continue" inherits unfinished work. Explicit pauses, cancellations
and replacement tasks change the scope; completed work adds no difficulty.
Executing a specified plan can still require reasoning and correctness checks.

All six questions share one TypeSafe request: pair selection, task complexity,
reasoning complexity, tool complexity, remaining reasoning and work status.
The diagnostics are independent assessments, not a weighted selection formula.

Each pair includes catalog capabilities, observed intelligence, measured task
cost and API rates. Jev prioritizes reliable completion, then cost among capable
pairs. Catalog descriptions are not quality evidence.
The [configured allowlist](configuration.md#model-policy) limits eligible models;
Codex's reasoning selection sets the effort ceiling. Manual selections bypass
classification.

Unmeasured efforts remain eligible. Measured efforts of the same model bound
capability comparisons; missing scores or prices are not copied from other
models. Equal rounded scores do not prove an upgrade. The price-quality frontier
is advisory and does not remove candidates.

## Safeguards

- If Jev fails or returns an invalid choice, keep the current eligible pair or
  initial fallback.
- Low-confidence reductions or uncertain capability changes keep the current
  pair unless separate assessments confidently establish completed, routine work.
- Unknown remaining reasoning prevents those reductions.
- During a continuation, those changes require both completed work and routine
  remaining steps, even with a confident pair recommendation.
- Quality upgrades remain eligible regardless of estimated cache cost.

A short status request can be routine; a short correctness question can be hard.
No prompt phrase forces a model or bypasses these checks.

## Cache and context

Only completed Responses usage establishes observed input, cache-read,
cache-write, output and reasoning-token counts. Failed or interrupted responses
do not establish usage, and older completions cannot overwrite newer state.

Cache reuse requires the same input prefix, instructions, tools, model, effort
and cache-affecting settings. Per-turn client metadata is ignored. The persisted
prefix record contains a hash and item count, not another copy of the input.
Compaction or other prefix changes invalidate reuse.

For a protected change, rebuilding that observed prefix can outweigh positive
benchmark task savings and keep the current pair. If rebuilding has a cost but
task savings are unmeasured, the pair is also retained. Without observed reuse,
missing task cost alone does not veto a change.

Context size uses observed input tokens for a matching prefix, then estimates
appended text. Otherwise it estimates visible text, instructions and tools.
Ciphertext and media size do not count as text tokens; unknown opaque content
is flagged. These estimates and API prices do not predict future cache hits or
Codex subscription quota.

## Reassessment and compaction

Changed user messages or tool results trigger reassessment at the next Responses
request. Successful tools can reveal harder work; a failure is not required.
Retries and continuations reuse identical accepted evidence across restarts.
The fingerprint covers routing questions, capabilities, supplied measurements, prices and
observation date.

New router notices use `msg_jev-` IDs and are excluded from Jev context.
Older notices without those IDs can remain. User quotations and other messages
are retained; OpenAI receives the original generation history.

Native compaction uses the last eligible pair or normal fallback without calling
Jev or replacing the routing decision. Both compaction metadata on `/responses`
and `/responses/compact` are supported. The standalone endpoint receives no
added reasoning parameter. Compaction input, output and opaque state pass
through. Turn identity survives restarts, so a summary does not become a new
user task.

The bridge does not inject `configuration_update` items or change Codex's
delegation instructions. Model switches preserve the full input, including
encrypted items.

## Notices

```text
[jev] keeping gpt-6 astra (high · confidence 0.20)
```

| State | Meaning |
| --- | --- |
| `selected` | Initial choice |
| `keeping` | Current pair retained |
| `switched to` | Model or effort changed |
| `fallback to` | Jev unavailable |

Confidence is Jev's recommendation confidence on its original 0–1 scale, not
answer accuracy or a percentage. It can describe a recommendation the safeguards
did not accept; unavailable confidence is `n/a`.
`$jev-explain` shows the recommendation, applied pair and policy reason.

## Evidence and validation

[model-profiles.json](../data/model-profiles.json) holds the September 30, 2026
snapshot with source URLs, per-effort Intelligence Index observations, weighted
benchmark task costs, API rates and reasoning-family metadata.
Jev receives aggregate intelligence and task cost; individual evaluations remain
in the data for research. Historical entries do not restore excluded models.

The package ships this snapshot and does not scrape benchmarks during routing.
Scores are aggregate observations, not task-specific success probabilities.
Weighted task cost is not a raw token price or cost per successful task.

The September 30 comparison tested 11 tasks twice per version with short and
long histories. Independent answer checks passed 44/44 for the revised router
and 43/44 for the preceding version. With the Sol/Astra allowlist and identified
notices excluded, Jev input tokens fell 49.9% on short histories and 6.4% on long
histories in this sample. Experiments remain outside the repository.

Offline checks covered 4,800 policy combinations. Native Codex checks covered
Sol/Astra switches, automatic compaction and context recall.
These checks do not establish a general accuracy, latency or savings guarantee.
