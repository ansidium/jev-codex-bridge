# Routing

Default routing selects once per fresh user instruction. Tool continuations and
identical retries retain the selected pair. Selecting a concrete model bypasses
the classifier. `JEV_CODEX_REASSESS_TOOLS=1` enables continuous reassessment.

## Selection and safeguards

One TypeSafe request evaluates the model-and-effort pair, remaining reasoning
and work status. The latest authorized task defines the scope; unfinished work
remains relevant, while paused, cancelled or completed work adds no difficulty.

Candidates come from the account catalog. Codex's reasoning selection sets the
effort ceiling. Jev prioritizes reliable completion, then cost among capable
pairs. Benchmarks are aggregate evidence, not success probabilities.

Uncertain selections preserve established capability. Measured efforts bound
comparisons within a model; missing scores and prices stay unknown. Continuous
reassessment permits capability upgrades, but protects unfinished reasoning
against premature reductions.

The cache guard uses observed successful Responses usage for the same input
prefix, model, effort and cache key. It can hold a reduction when rebuilding the
cached prefix costs more than measured task savings. Missing usage never
creates a cache-rebuild veto. Quality upgrades remain eligible.

## State and failures

Decisions and usage are isolated per conversation. Turn identity, retries and
native compaction survive restarts. Summaries do not replace the original task.
Late responses cannot overwrite newer decisions.

Unavailable TypeSafe requests retain the current eligible pair or cold fallback.
Authentication, credit and rate-limit errors pause classification for 60 seconds.
Cancelling a Codex request also cancels its pending classification.

The bridge changes only the selected model and effort; it preserves the input,
tools, permissions and authentication. `$jev-explain` reads the saved decision
without another classifier call.
