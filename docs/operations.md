# Operations

`jev-codex` starts and stops its own proxy. CLI-only installation has no
background service; `jev-bridge status` may therefore report `ready: false`.

## Persistent gateway

```powershell
jev-bridge status
jev-bridge service start
jev-bridge service stop
jev-bridge service restart
jev-bridge service schedule --update-time 23:30
```

`install --desktop` registers `JevCodexBridge` at login and
`JevCodexBridge-Update` daily. Both run under the signed-in Windows user without
a console window. Stop, restart and removal refuse active requests.

## Updates

```powershell
jev-bridge update
jev-bridge rollback
jev-bridge auto-update on
jev-bridge auto-update off
```

Updates fetch an exact `main` revision, install the lockfile with lifecycle
scripts disabled, then run syntax checks and offline tests. Failed candidates
remain inactive. Activation waits for in-flight requests to finish.
Local source edits block replacement. Rollback pauses automatic updates;
CLI-only installations leave them off by default.

## Local files

Files below are relative to `~/.config/jev-codex-bridge` or `--home`.

| Path | Contents |
| --- | --- |
| `settings.json` | Port, key-file path and optional task schedule |
| `state.json`, `versions/` | Active and previous validated versions |
| `backups/`, `codex-config.json` | Optional profile restoration data |
| `update-status.json` | Last update result |
| `serve.log`, `update.log` | Service output; rotates after 5 MiB |
| `control.token` | Local shutdown credential |

## Disconnect

```powershell
jev-bridge restore-config
jev-bridge service remove
npm uninstall --global jev-codex-bridge
```

Restore the optional profile before removing its service. Restoration refuses
to overwrite later edits and prints the backup path for a manual merge.
Legacy backups restore only the exact configuration they recorded.
Task removal preserves the installation and key file.
