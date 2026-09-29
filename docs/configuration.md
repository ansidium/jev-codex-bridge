# Configuration

The installation lives in `~/.config/jev-codex-bridge`.
Override it with `--home PATH` or `JEV_BRIDGE_HOME`.

```powershell
jev-bridge install --key-file "D:\Private\jev.env" --port 18767
```

The key file is read in place; credentials are not copied into the package,
Codex configuration or task arguments. Existing environment variables take
precedence. Both `TYPESAFE_API_KEY` and `JEV_API_KEY` are accepted.

| Install option | Default or effect |
| --- | --- |
| `--key-file` | `~/.jev-router.env` |
| `--port` | `18767` |
| `--codex-home` | `CODEX_HOME`, or `~/.codex` |
| `--task-name` | `JevCodexBridge` |
| `--update-time` | Current local time; accepts `HH:mm` |
| `--no-config` | Skip Codex configuration |
| `--no-service` | Skip Windows task registration |

Separate installations need different ports and task names. After
`--no-config`, start the service and run `jev-bridge configure`.

Setup writes `model = "jev-router"`, `model_provider = "jev"` and the local
Responses provider into `config.toml`. Other settings are preserved; the original
file is saved under `backups/`. See [restoration](operations.md#disconnect).

## Existing tasks

Changing a task's model does not change its provider. An OpenAI task can
therefore reject `jev-router` as unsupported.

Close Codex Desktop and any CLI using the task, then run:

```sh
jev-bridge attach THREAD_ID
```

Use the UUID from the copied task link and reopen Codex afterward.
The service must be running and Codex must be on `PATH`. Attach resumes the same
task through Codex's app-server without sending a model prompt. An active writer
blocks attachment; database and rollout files are not edited directly.

## Model policy

Put the automatic model allowlist in the key file:

```dotenv
JEV_CODEX_INCLUDE_MODELS=gpt-6.1-sol,gpt-6-astra
```

Only those models and their catalog-supported efforts can be selected.
GPT-6.1 Sol and Astra support `low`, `medium`, `high`, `xhigh`, `max` and `ultra`
when exposed by the account. The user's reasoning selection is a ceiling.

| Variable | Effect |
| --- | --- |
| `JEV_CODEX_INCLUDE_MODELS` | Comma-separated allowed IDs; unset allows all compatible models, empty allows none |
| `JEV_CODEX_EXCLUDE_MODELS` | Comma-separated excluded IDs; exclusions take precedence |
| `JEV_ALLOW_FABLE=0` | Disable the legacy frontier tier, including Astra |

Filters apply to catalog choices and fallback. Hidden, API-disabled and
Responses Lite-incompatible models are excluded. Manual selections pass through.

Catalogs are cached per account or API credential and Codex client version.
Concurrent cold requests share a fetch; explicit refreshes supersede pending
cold fetches. A known empty catalog returns an error. Failed fetches can retry.

If a catalog fetch fails before any catalog is loaded, these configurable
compatibility aliases provide fallback IDs. The allowlist still applies:

| Variable | Fallback ID |
| --- | --- |
| `JEV_CODEX_FAST_MODEL` | `gpt-6-luna` |
| `JEV_CODEX_BALANCED_MODEL` | `gpt-5.6-terra` |
| `JEV_CODEX_STRONG_MODEL` | `gpt-6.1-sol` |
| `JEV_CODEX_LONG_MODEL` | `gpt-6-astra` |

The Desktop service reads its configured key file. After changing that file,
restart the service once active requests have finished.
The CLI loads `.env` from its working directory, then `~/.jev-router.env` and
the legacy `~/.jev-claude.env`, preserving values already set.

## Routing context

The classifier defaults to `jev-1.13.0`.
`TYPESAFE_DEFAULT_MODEL` overrides the classifier version.

| `JEV_ROUTING_CONTEXT` | Text sent to Jev |
| --- | --- |
| `task` (default) | Current request, user/assistant history, repository constraints, reasoning summaries, tool calls and results |
| `full` | Task context plus system/developer instructions and tool schemas |
| `previous` | Current and previous user requests, without message/tool history |

Task mode retains AGENTS.md supplied in user context and constraints read through
tools. Use `full` when a custom client places task constraints in system/developer
messages. Identified `msg_jev-` commentary notices are excluded in both modes.

Images, audio and files become content-unavailable indicators. Binary payloads,
encrypted reasoning and authentication headers are not sent to Jev.
Environment-only messages are omitted. These filters do not change the
conversation sent to OpenAI.

The previous request is supplied when absent from history, including after a
restart. `JEV_PREVIOUS_CONTEXT_CHARS` can limit that field: `0` disables it;
integers of at least `256` cap it. The default is unlimited.

The bridge budgets 32k tokens for state plus the longest question and 64k for the
batched request. Oversized routing text is fitted with omission markers,
prioritizing the current request, constraints, reasoning summaries and failed
tool evidence. Fitting can omit relevant details; it is not an exact tokenizer.
A `max_tokens_exceeded` response triggers a smaller-context retry within the
same 10-second deadline. `$jev-explain` reports the mode and fitting.

## Diagnostics

Decisions are stored under `jev-claude` in Node's temporary directory. Each task
retains 20 decisions with prompt text, routing context and Jev exchanges. Files
older than seven days are pruned during writes. Unix files use owner-only
permissions; Windows uses the temporary directory's ACLs.

`JEV_DEBUG` enables routing logs. `JEV_DUMP` writes request bodies under the
given path prefix. Both default to off. Diagnostics can contain private text.
