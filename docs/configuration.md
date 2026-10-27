# Configuration

Installation state lives in `~/.config/jev-codex-bridge`.
Use `--home PATH` or `JEV_BRIDGE_HOME` to choose another directory.

## Installation modes

`jev-bridge install` prepares the optional CLI without a background service or
global Codex changes. `--desktop` explicitly adds a persistent gateway and a
named `jev.config.toml` profile. Select it with `codex --profile jev`.

| Option | Effect |
| --- | --- |
| `--key-file PATH` | Read credentials in place; default `~/.jev-router.env` |
| `--port NUMBER` | Persistent gateway port; default `18767` |
| `--codex-home PATH` | Profile destination; default `CODEX_HOME` or `~/.codex` |
| `--no-config` | Skip profile creation in Desktop mode |
| `--no-service` | Skip Windows tasks in Desktop mode |
| `--task-name NAME` | Windows task prefix; default `JevCodexBridge` |
| `--update-time HH:mm` | Daily update time; default installation time |

The main `config.toml` is never rewritten. `jev-bridge configure` creates the
optional profile after the service is ready. A previous profile is backed up.
Separate installations need different ports and task names.

## Credentials

Both `TYPESAFE_API_KEY` and `JEV_API_KEY` are accepted. Existing environment
values take precedence. The CLI reads `.env` in its working directory,
`~/.jev-router.env`, legacy `~/.jev-claude.env`, then the managed key file.
The service reads its configured key file on startup.
Keys are not copied into Codex settings or task arguments.

## Models and classifier

| Variable | Default or purpose |
| --- | --- |
| `JEV_CODEX_INCLUDE_MODELS` | Optional comma-separated allowlist |
| `JEV_CODEX_EXCLUDE_MODELS` | Optional comma-separated exclusions |
| `JEV_CODEX_FAST_MODEL` | Cold fallback `gpt-6-luna` |
| `JEV_CODEX_BALANCED_MODEL` | Cold fallback `gpt-6.1-terra` |
| `JEV_CODEX_STRONG_MODEL` | Cold fallback `gpt-6.1-sol` |
| `JEV_CODEX_LONG_MODEL` | Cold fallback `gpt-6-astra` |
| `JEV_ALLOW_FABLE=0` | Exclude the strongest compatibility tier |
| `TYPESAFE_DEFAULT_MODEL` | Classifier; default `jev-1.14.0` |
| `JEV_CODEX_REASSESS_TOOLS=1` | Opt in to continuous tool reassessment |

The account catalog determines available models and reasoning levels. Filters
apply to automatic selection and fallback. Manual models pass through.
Catalogs are isolated by account or credential and Codex version; an empty
catalog returns an error, while a failed first fetch permits cold fallbacks.

`data/model-profiles.json` records prices, measurement dates and source URLs.
Missing benchmark results remain unknown; they are never copied from another model.

## Context and diagnostics

The classifier receives the current task and relevant conversation by default.
`JEV_ROUTING_CONTEXT=previous` limits it to the current and previous request.
`JEV_PREVIOUS_CONTEXT_CHARS=0` omits the previous request; a finite limit must
be at least 256 characters. The default preserves it in full.

`JEV_DEBUG=1` enables routing diagnostics. `JEV_DUMP=PATH` writes full request
snapshots; these may contain private conversation text.

## Existing tasks

For an explicit provider migration, close the task in Codex Desktop and CLI,
then run `jev-bridge attach THREAD_ID`. The service and optional profile must
be configured. Attachment uses Codex's app-server without starting a model turn;
active writers block it. Reopen the task with the Jev profile.
