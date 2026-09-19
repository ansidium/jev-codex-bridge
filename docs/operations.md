# Operations

```powershell
jev-bridge status
jev-bridge service restart
```

`status` reports the running service, active installation, previous version and
update setting. A stopped service reports `ready: false`.

## Windows tasks

| Task | Runs |
| --- | --- |
| `JevCodexBridge` | At login; restarts after a process failure |
| `JevCodexBridge-Update` | Daily at 10:00 local time |

10:00 is the initial schedule. To change it, open **Task Scheduler**, select
`JevCodexBridge-Update`, then edit its trigger under **Properties > Triggers**.
Source updates preserve the schedule you set.

Both tasks run under the signed-in user, independently of Codex Desktop. They
require that user to be logged in. Missed scheduled runs use the next available
opportunity. `service start`, `stop`, `restart`, `status` and `remove` manage them.
Stopping refuses while a request is active; retry after the turn finishes.

## Update and rollback

`jev-bridge update` fetches an exact revision of this repository's `main` branch,
installs the committed lockfile with npm lifecycle scripts disabled, and runs
syntax checks and offline tests. A successful candidate becomes active; the worker
finishes existing requests before restarting. Failed candidates remain inactive.

Each installation has a source hash. Local edits or unknown source files block
replacement. Dependency changes enter through reviewed repository commits;
the updater does not run `npm update` on your installed version.

```powershell
jev-bridge rollback
jev-bridge auto-update on
```

Rollback selects the previous validated version and pauses automatic updates.
Versions are retained for inspection. The updater does not delete them.

## Files

All paths below are relative to the installation home:

| File or directory | Purpose |
| --- | --- |
| `settings.json` | Port, task name and key-file path |
| `state.json` | Active and previous versions, update setting |
| `versions/` | Installed source and dependencies |
| `backups/` | Original Codex configuration |
| `update-status.json` | Last update result |
| `serve.log`, `update.log` | Service and update output |
| `control.token` | Local shutdown credential |

Logs larger than 5 MB rotate on the next task launch. Never share `control.token`,
environment files, or unredacted prompt diagnostics.

## Disconnect

Restore Codex before removing the service:

```powershell
jev-bridge restore-config
jev-bridge service remove
```

If you edited `config.toml` after installation, restoration stops and prints the
backup path. Merge the desired settings manually. Task removal keeps installation
files and keys. The global commands can then be removed with
`npm uninstall --global jev-codex-bridge`.

If startup fails, check `serve.log`, the task state and whether another process
owns the configured port. After fixing the cause, use `service start`.
