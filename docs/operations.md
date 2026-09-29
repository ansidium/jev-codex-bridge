# Operations

```powershell
jev-bridge status
jev-bridge service restart
```

`status` reports the running worker, installed active version, previous version
and automatic-update setting. Installed and running versions can differ while
requests finish. A stopped service reports `ready: false`.

## Windows tasks

| Task | Schedule |
| --- | --- |
| `JevCodexBridge` | At login; restarts after process failure |
| `JevCodexBridge-Update` | Daily at the configured local time |

Both run under the signed-in user and require that user to be logged in.
Missed updates run at the next available opportunity.

Set the time with `install --update-time HH:mm`; the default is the installation
time. To change it later:

```powershell
jev-bridge service schedule --update-time 23:30
```

Source updates preserve the schedule. Service controls are `start`, `stop`,
`restart`, `status` and `remove`. Stop, restart and removal refuse active
requests; retry after they finish. The launcher runs without a console window.

## Update and rollback

```powershell
jev-bridge update
jev-bridge rollback
jev-bridge auto-update on
```

Update fetches an exact `main` revision, installs its lockfile with lifecycle
scripts disabled, and runs syntax checks and offline tests. Successful versions
activate when the worker is idle. Failed candidates remain inactive.

Source hashes protect installed versions: local edits or unexpected source files
block replacement. Updates refresh Windows task actions without changing their
triggers; `service start` also refreshes the launcher.

Rollback selects the previous validated version and pauses automatic updates.
`auto-update on` re-enables them. Old versions remain on disk for inspection.

## Files and logs

Paths are relative to `~/.config/jev-codex-bridge` or the selected installation home.

| Path | Contents |
| --- | --- |
| `settings.json` | Port, task name, schedule and key-file path |
| `state.json` | Active and previous versions, update setting |
| `versions/` | Installed source and dependencies |
| `backups/` | Original Codex configuration |
| `update-status.json` | Last update result |
| `serve.log`, `update.log` | Service and update output |
| `control.token` | Local shutdown credential |

Logs over 5 MiB rotate on task launch. Do not share credentials or unredacted
prompt diagnostics. If startup fails, check `serve.log`, task state and port
availability, then run `service start` after fixing the cause.

## Disconnect

```powershell
jev-bridge restore-config
jev-bridge service remove
npm uninstall --global jev-codex-bridge
```

Restore Codex before removing the service. Restoration stops if `config.toml`
was edited after setup and prints the backup path for a manual merge.
Task removal preserves installed files and the key file.
