# Configuration

The shared installation lives in `~/.config/jev-codex-bridge`. Commands accept
`--home PATH`; `JEV_BRIDGE_HOME` provides the same override for all three launchers.

```powershell
jev-bridge install --key-file "D:\Private\jev.env" --port 18767
```

The installer reads the key file in place. It does not copy keys into the package,
Codex configuration or scheduled-task arguments. Existing environment variables
take precedence. `JEV_API_KEY` and `TYPESAFE_API_KEY` are both accepted.

| Install option | Default |
| --- | --- |
| `--key-file` | `~/.jev-router.env` |
| `--port` | `18767` |
| `--codex-home` | `CODEX_HOME`, or `~/.codex` |
| `--task-name` | `JevCodexBridge` |
| `--update-time` | Local time when installation starts (`HH:mm`) |
| `--no-config` | Skip changes to Codex |
| `--no-service` | Skip Windows task registration |

Separate installations need different ports and task names. After installing
without configuration, start the service and run `jev-bridge configure`.

Desktop setup writes `model = "jev-router"`, `model_provider = "jev"` and the local
Responses API provider into `config.toml`. It preserves other settings and saves
the original file, including comments, under `backups/`. Serialization normalizes
the active file's formatting. `jev-bridge restore-config` restores the exact backup
only if the active file has not been edited since setup.

## Existing tasks

Changing the model in an existing task does not change its provider. A task
created with OpenAI can therefore send `jev-router` directly to OpenAI, which
rejects it as an unsupported model.

Close Codex Desktop and any CLI using the task, then run:

```sh
jev-bridge attach THREAD_ID
```

Use the UUID from the task's copied link. Reopen Codex afterward. The command
uses Codex's local app-server to resume the same task with the `jev` provider and
`jev-router` model. It preserves the conversation and sends no prompt to a model.
The bridge service must be running, and Codex must be on `PATH`.

An active writer is left intact: the command asks you to close that Codex process
and retry. It does not edit the database or rollout files directly, interrupt work, or
change other tasks. New tasks use the provider chosen during installation and
do not need this step. Codex continues to use its existing ChatGPT or API login.

## Model policy

The account catalog supplies the available model IDs and reasoning capabilities.
Before that catalog arrives, the router uses these configurable defaults:

| Variable | Fallback model |
| --- | --- |
| `JEV_CODEX_FAST_MODEL` | `gpt-5.6-luna` |
| `JEV_CODEX_BALANCED_MODEL` | `gpt-5.6-terra` |
| `JEV_CODEX_STRONG_MODEL` | `gpt-5.6-sol` |
| `JEV_CODEX_LONG_MODEL` | `gpt-6-astra` |

The last entry is the frontier tier. `JEV_ALLOW_FABLE=0` disables it; the variable
and internal tier names are inherited from Jev Router. All account-visible tiers
are enabled by default. Names and configured IDs identify the legacy aliases;
catalog descriptions are not used as evidence of quality.

Automatic selection excludes hidden models and models whose catalog metadata
rejects the request's Responses Lite format. `JEV_CODEX_EXCLUDE_MODELS` excludes
additional model IDs, separated by commas. Manual model selections pass through.

This table lists fallback model IDs, not reasoning levels or selection frequency.
Model and effort are chosen together. Astra can run at `low`, `medium`, `high`,
`xhigh`, `max` or `ultra` when those levels are present in the account catalog.
Luna can use `max` under an Ultra ceiling without receiving an unsupported effort.
All compatible pairs remain eligible; an aggregate benchmark does not establish
that a model is worse on every task. See [routing](routing.md) for the evidence.
Selecting Astra does not force high effort; the router can choose Astra with `low`.

The CLI additionally loads `.env` in its working directory, then
`~/.jev-router.env` and the legacy `~/.jev-claude.env`. The Desktop service reads
only its configured key file. Restart the service after changing that file.

`JEV_PREVIOUS_CONTEXT_CHARS` sets how much of the previous user request goes to
Jev (default `8000`; `0` disables it; otherwise `256` to `32000`). Long requests
retain their beginning and end with an omission marker. The current user request
is sent in full. This setting changes routing context, not Codex's conversation.

## Diagnostics

Explanation files use the legacy `jev-claude` folder inside Node's OS temp
directory. Each task retains its last 20 decisions, including prompt text and Jev
exchanges. Files untouched for seven days are pruned on a later diagnostic write.
Unix permissions are owner-only; Windows uses the user's temp-directory ACLs.

`JEV_DEBUG` adds routing logs. `JEV_DUMP` writes full request bodies to files under
the supplied path prefix. Both are off by default and can expose private text.
