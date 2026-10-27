# Jev Codex Bridge

[TypeSafe Jev](https://docs.typesafe.ai) selects a model and reasoning effort
for an optional Codex session, using your existing Codex login.
Normal Codex keeps its native OpenAI provider and voice route.

## Install and run

Requires Node.js 24+, npm, Git, Codex and a
[TypeSafe API key](https://console.typesafe.ai/settings/keys).

```powershell
npm install --global git+https://github.com/ansidium/jev-codex-bridge.git --ignore-scripts
```

Create `~/.jev-router.env`:

```dotenv
TYPESAFE_API_KEY=your-key
JEV_CODEX_INCLUDE_MODELS=gpt-6.1-terra,gpt-6.1-sol,gpt-6-astra
```

```powershell
jev-bridge install
jev-codex
jev-codex resume --last
jev-codex exec "fix the failing test"
```

Default installation starts no service and does not edit `config.toml`.
The proxy runs only while `jev-codex` is open. **Jev Router** enables routing;
selecting a concrete model bypasses it. Use `$jev-explain` for the last decision.

## Behavior

- Classifies fresh user instructions once; tools keep the selected pair.
- Uses the account's model catalog and reasoning levels, including GPT-6.1 Terra.
- Preserves the current eligible pair when TypeSafe is unavailable.
- Cancels classification with the request and pauses repeated auth, credit or
  rate-limit failures for 60 seconds.

TypeSafe receives routing text and model metadata. OpenAI receives the full
Codex request. Routing decisions are stored locally.

## Optional persistent gateway

On a new installation, `jev-bridge install --desktop` adds a Windows service and
`~/.codex/jev.config.toml`. Select the profile with `codex --profile jev`.
The main configuration remains unchanged. Keep native OpenAI sessions for voice.
On macOS and Linux add `--no-service` and run `jev-bridge serve` under a supervisor.

See [configuration](docs/configuration.md), [routing](docs/routing.md) and
[operations](docs/operations.md) for options, updates and removal.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests run without API keys. Based on [Jev Router](https://github.com/gargpratyush/jev-router).
[MIT](LICENSE) / [Attribution](NOTICE)
