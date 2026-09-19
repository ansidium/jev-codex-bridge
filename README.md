# Jev Codex Bridge

[![Checks](https://github.com/ansidium/jev-codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/ansidium/jev-codex-bridge/actions/workflows/ci.yml)

Model and reasoning routing for Codex Desktop and CLI, powered by
[TypeSafe Jev](https://docs.typesafe.ai).

Jev chooses a model and reasoning effort together when you send a message, up to
the level you selected in Codex. Choices use published benchmark observations
and your account's supported models. The rest of the turn keeps that choice,
including tool calls.

The Windows installer sets up a local service, daily updates and rollback.
Codex uses its existing login.

## Quick start

Requires **Node.js 24+, npm, Git, Codex**, and a
[TypeSafe API key](https://console.typesafe.ai/settings/keys).

```powershell
npm install --global git+https://github.com/ansidium/jev-codex-bridge.git --ignore-scripts
```

Create `~/.jev-router.env` outside your repositories:

```dotenv
TYPESAFE_API_KEY=your-key
```

Install the Desktop service:

```powershell
jev-bridge install
jev-bridge status
```

Restart Codex Desktop. **Jev Router** appears in the model picker and becomes the
default for new tasks. In tasks connected to the bridge, choosing a concrete model
pauses routing; choosing Jev Router resumes it.

Existing tasks retain their original provider. To connect one, close Codex Desktop
and any CLI using that task, then run `jev-bridge attach THREAD_ID` and reopen Codex.
The ID is the UUID in the task's copied link. History stays in the same task.

The installer backs up `config.toml` before writing the provider settings.
Other settings are preserved; TOML formatting is normalized.

For the CLI, run `jev-codex` from any project. Codex arguments pass through:

```sh
jev-codex resume --last
jev-codex exec "fix the failing test"
```

Windows service setup is included. On macOS or Linux, use
`jev-bridge install --no-service` and run `jev-bridge serve` under your own supervisor.
See [configuration](docs/configuration.md) for existing key files, paths and ports.

## What gets routed

```text
Codex Desktop / CLI
        |
        v
  local bridge ----> Jev: choose model + effort
        |
        v
  OpenAI, using your Codex login
```

Each decision appears in the task:

```text
[Jev] routed this turn to gpt-6-astra (jev, confidence 0.88, effort xhigh).
```

Run `$jev-explain` in Codex to inspect the recommendation, selected model,
confidence and policy decision. Reports are stored separately for each task.

The routing policy:

- Reads model IDs and supported reasoning levels from the account catalog.
- Compares model-and-effort pairs using dated benchmark scores, task costs and
  token prices. Required quality takes priority over cost.
- Reads the task history, constraints, assistant responses and tool results so a
  short “go ahead” retains the underlying work and unresolved failures.
- Treats your reasoning selection as a ceiling. A model without Ultra support
  uses a supported level within that ceiling.
- Keeps the current model if Jev fails. Low confidence prevents a downgrade.
- Considers loss of reusable reasoning when switching model families.
- Estimates cache rebuilding before a downgrade; a fresh task has no such cost.

See [routing evidence and limits](docs/routing.md). Observations live in
[data/model-profiles.json](data/model-profiles.json); selection instructions and
thresholds live in [src/config.mjs](src/config.mjs).
The bridge does not control when Codex delegates work to agents.

## Updates

Windows setup enables startup at login and automatic updates.
New versions are tested before activation.

The service switches versions after active requests finish. There is a brief
reconnect during the restart. The previous version remains available:

```powershell
jev-bridge update
jev-bridge rollback
```

Rollback pauses automatic updates. Re-enable them with `jev-bridge auto-update on`.
Service controls, logs and removal are covered in [operations](docs/operations.md).

## Data and limits

TypeSafe receives the current user text, visible task history and tool inputs and
results, approximate context size and model metadata. There is no default 8,000
character cut on the previous request. Images and other media are represented by
text indicators; encrypted reasoning is omitted. The full Codex request goes to
OpenAI. Local explanation files contain the routing context and classification
results; keep them private.

The default `task` context omits global instructions and tool schemas. Set
`JEV_ROUTING_CONTEXT=full` to include them, or `previous` for current and previous
user requests only. Context is fitted to Jev's input window, with omission markers
when needed; Codex's conversation is unchanged. See [configuration](docs/configuration.md).

The service listens on `127.0.0.1`, requires Codex authorization, and rejects browser
requests with an Origin header. It is intended for a single local user.

Codex request formats can change. The tests cover the formats used here, with a
separate live check against Codex Desktop on Windows. Savings depend on your
workload; this project has no comparative cost benchmark.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run check
```

Tests use local mock servers and synthetic prompts. They need no API keys.
CI runs on Windows, Linux and macOS. Dependency updates arrive as Dependabot PRs;
changes from upstream Jev Router are reviewed before being included.

For bug reports, include your OS, Node and Codex versions, the command you ran,
and the error. Remove keys and prompt text from logs before sharing them.

Based on [Jev Router](https://github.com/gargpratyush/jev-router).
[MIT](LICENSE) · [Attribution](NOTICE)
