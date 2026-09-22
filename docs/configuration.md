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
| `JEV_CODEX_FAST_MODEL` | `gpt-6-luna` |
| `JEV_CODEX_BALANCED_MODEL` | `gpt-5.6-terra` |
| `JEV_CODEX_STRONG_MODEL` | `gpt-6-sol` |
| `JEV_CODEX_LONG_MODEL` | `gpt-6-astra` |

The last entry is the frontier tier. `JEV_ALLOW_FABLE=0` disables it; the variable
and internal tier names are inherited from Jev Router. All account-visible tiers
are enabled by default. Names and configured IDs identify the legacy aliases;
catalog descriptions are not used as evidence of quality.

Automatic selection excludes hidden models and models whose catalog metadata
rejects the request's Responses Lite format. `JEV_CODEX_EXCLUDE_MODELS` excludes
additional model IDs, separated by commas. Manual model selections pass through.
For example, `JEV_CODEX_EXCLUDE_MODELS=gpt-5.6-luna` retires the previous Luna
from automatic selection without removing manual access. GPT-5.6 Sol remains
eligible when the account catalog exposes it, including its Max profile.

This table lists fallback model IDs, not reasoning levels or selection frequency.
Model and effort are chosen together. GPT-6 Sol and Astra can run at `low`, `medium`, `high`,
`xhigh`, `max` or `ultra` when those levels are present in the account catalog.
Luna can use `max` under an Ultra ceiling without receiving an unsupported effort.
All compatible pairs remain eligible; an aggregate benchmark does not establish
that a model is worse on every task. See [routing](routing.md) for the evidence.
Selecting Astra does not force high effort; the router can choose Astra with `low`.

The CLI additionally loads `.env` in its working directory, then
`~/.jev-router.env` and the legacy `~/.jev-claude.env`. The Desktop service reads
only its configured key file. Restart the service after changing that file.

## Routing context

The classifier defaults to the tested `jev-1.13.0` release. The SDK's
`TYPESAFE_DEFAULT_MODEL` variable can select another version or `jev-latest`;
recheck routing behavior when changing it. [TypeSafe aliases](https://docs.typesafe.ai/models)
can move to a different release without a bridge update.

`JEV_ROUTING_CONTEXT` selects the text made available to Jev:

| Value | Data sent |
| --- | --- |
| `task` (default) | Current request, user and assistant history, repository constraints from user context and tool results, reasoning summaries, tool calls and results |
| `full` | The same history plus system/developer instructions and tool schemas |
| `previous` | Current and previous user requests without the message/tool history |

The previous request is also supplied when it is missing from the received
history, including after a service restart. Image, audio and file content becomes
a text indicator; Jev cannot inspect it. Encrypted reasoning, authentication
headers and binary media are not sent. Environment-only injected messages are
omitted. Task and sub-agent contexts remain isolated.

Task mode excludes system/developer messages by role, including instructions
reinjected after compaction. Codex supplies AGENTS.md in user context; those
constraints and files read through tools are retained. Use `full` if a custom
client supplies task-specific constraints in system/developer messages. This
filter only affects Jev's evidence; the conversation sent to OpenAI is unchanged.

There is no default character limit on a previous request. The optional
`JEV_PREVIOUS_CONTEXT_CHARS` retains its explicit override (`0` or an integer of
at least `256`). It affects the separate previous-request field, not messages in
the task history. To reproduce the earlier data selection, use
`JEV_ROUTING_CONTEXT=previous` with `JEV_PREVIOUS_CONTEXT_CHARS=8000`.

[Jev 1.13](https://docs.typesafe.ai/models) allows 32k tokens for state plus the
longest question, and 64k for state plus all questions. The bridge estimates an
initial byte budget after accounting for questions and model choices. If Jev
returns `max_tokens_exceeded`, it retries with a smaller context within the same
10-second total deadline. This is an estimate, not a local Jev tokenizer.

When fitting is necessary, the bridge prioritizes user constraints, reasoning
summaries and failed tool evidence, including significant lines in the middle of
long results. Retained records remain in source order with omission markers;
large individual records retain their ends and significant interior lines. These
heuristics cannot guarantee that every relevant detail survives. The current
request has priority; an oversized current request may itself need an excerpt.
`$jev-explain` reports the mode and whether fitting occurred. All of this changes
only routing data; the original Codex history still goes to OpenAI.

## Diagnostics

Explanation files use the legacy `jev-claude` folder inside Node's OS temp
directory. Each task retains its last 20 decisions, including prompt text, task
context, tool evidence and Jev exchanges. Files untouched for seven days are pruned on a later diagnostic write.
Unix permissions are owner-only; Windows uses the user's temp-directory ACLs.

`JEV_DEBUG` adds routing logs. `JEV_DUMP` writes full request bodies to files under
the supplied path prefix. Both are off by default and can expose private text.
