# Jev Codex Bridge

[![Checks](https://github.com/ansidium/jev-codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/ansidium/jev-codex-bridge/actions/workflows/ci.yml)

[TypeSafe Jev](https://docs.typesafe.ai) selects a model and reasoning effort
for Codex Desktop and CLI. The local bridge uses your existing Codex login.
Windows setup includes a background service, tested updates and rollback.

## Quick start

Requires Node.js 24+, npm, Git, Codex and a
[TypeSafe API key](https://console.typesafe.ai/settings/keys).

```powershell
npm install --global git+https://github.com/ansidium/jev-codex-bridge.git --ignore-scripts
```

Create `~/.jev-router.env` outside your repositories. This policy limits
automatic selection to GPT-6.1 Sol and GPT-6 Astra:

```dotenv
TYPESAFE_API_KEY=your-key
JEV_CODEX_INCLUDE_MODELS=gpt-6.1-sol,gpt-6-astra
```

```powershell
jev-bridge install
jev-bridge status
```

Restart Codex Desktop after first-time setup. Select **Jev Router** to enable
routing or a concrete model to choose manually.

Existing tasks keep their provider. To connect one, close Codex Desktop and any
CLI using that task, run `jev-bridge attach THREAD_ID`, then reopen Codex.
Use the UUID from the task's copied link.

For the CLI:

```sh
jev-codex resume --last
jev-codex exec "fix the failing test"
```

On macOS and Linux, install with `jev-bridge install --no-service` and run
`jev-bridge serve` under your own supervisor.

## Routing

- Selects a supported model-and-effort pair from task history and tool results.
  Your reasoning selection sets the ceiling.
- Reassesses changed user instructions and tool evidence, including successful
  results. Retries and continuations reuse decisions when evidence is unchanged.
- Protects unfinished reasoning and observed cache reuse when reducing capability
  or effort. Quality upgrades remain eligible.
- Keeps the current eligible pair, or the initial fallback, if Jev is unavailable.

TypeSafe receives routing text and model metadata. OpenAI receives the Codex
conversation. Decisions and routing context are stored locally.

Run `$jev-explain` in Codex for the decision details.

## Updates

```powershell
jev-bridge update
jev-bridge rollback
```

Validated updates activate when current requests finish. Rollback pauses
automatic updates; `jev-bridge auto-update on` re-enables them.

| Guide | Contents |
| --- | --- |
| [Configuration](docs/configuration.md) | Model policy, key files, context and diagnostics |
| [Routing](docs/routing.md) | Selection, cache protection, compaction and evidence |
| [Operations](docs/operations.md) | Service controls, updates, logs and removal |

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests require no API keys. CI covers Windows, Linux and macOS.

Based on [Jev Router](https://github.com/gargpratyush/jev-router).
[MIT](LICENSE) · [Attribution](NOTICE)
