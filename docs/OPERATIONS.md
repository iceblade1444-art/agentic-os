# Operations, monitoring and backups

Agentic OS keeps host administration outside the web container. The container
does not receive the Docker socket, systemd access or a shell bridge.

## Services

Run the installer once on the production host:

```bash
cd ~/agentic-os
bash scripts/install-agentic-os-operations.sh
```

It installs these user-level units:

| Unit | Purpose |
| --- | --- |
| `agentic-os-monitor.timer` | Runs health checks every five minutes |
| `agentic-os-backup.timer` | Creates a backup daily at 03:15 with a randomized delay |
| `agentic-os-backup.path` | Watches for a backup requested from the dashboard |
| `agentic-os-restore-drill.path` | Watches for a restore verification requested from the dashboard |
| `agentic-os-monitor.service` | Checks HTTP, containers, Hermes services, disk and backup age |
| `agentic-os-backup.service` | Archives persistent application data and applies retention |
| `agentic-os-restore-drill.service` | Verifies the latest backup in a temporary restore directory |

Timers use `Persistent=true`, so a missed run starts after the server comes back.
The dashboard reads `$HOME/.local/state/agentic-os/operations.json` through the
authenticated `/api/operations/status` endpoint. A manual request only creates
`backup.request` or `restore.request`; the host path unit performs the
privileged work.

## Backup contents

Each backup directory contains:

- the server `.env` with mode `0600`;
- the deployed Git commit;
- `data.tgz` with users and server state;
- `vault.tgz` with the Obsidian library;
- `agentos-runtime.tgz` with agent memory, logs, projects and workspaces;
- `hermes-control.tgz` with routine definitions and verified outputs, Kanban
  and project databases, plus the `SOUL.md` and Markdown memory of each profile;
- `manifest.json` with timestamp, size and archive names.

The Hermes archive is deliberately selective. It excludes provider credentials,
OAuth files, auth state, pairing data, sessions, caches and `config.yaml`.
SQLite databases are copied through the online backup API instead of copying
live WAL files.

Backups are stored in `$HOME/backups/agentic-os`. `node_modules`, `.git` and
Python cache directories are excluded. Defaults keep 14 days and at most 14
copies. Configure the host through `.env`:

```dotenv
OPS_BACKUP_RETENTION_DAYS=14
OPS_BACKUP_MAX_COUNT=14
OPS_HEALTH_URL=http://172.16.10.6:8787/api/health
OPS_PUBLIC_HEALTH_URL=https://agent.example.com/api/health
```

`OPS_HEALTH_URL` is optional. Set it when Docker is bound to a non-loopback host
address; otherwise the monitor derives the internal endpoint from `BIND_ADDRESS`
and `HOST_PORT`. Direct host commands also read missing values from the project
`.env`, matching the systemd services. The public URL check is optional but
recommended: it detects nginx, DNS and TLS failures that an internal container
probe cannot see.

## Restore drills

The Observability page includes **Verify restore**. It does not overwrite the
live application. The request creates `restore.request`, then the host service
selects the newest backup, reads `manifest.json` and `git-head`, checks every tar
member for unsafe paths, extracts the archives into a temporary directory under
the operations state directory, counts restored files, and removes the temporary
directory.

Run the same check manually on the server with:

```bash
python3 scripts/agentic-os-operations.py restore-drill
```

The result is written to `restoreDrill` in the operations state and appears in
Operational Home, Observability, and the Four C readiness audit.

## Notifications

Notifications are sent only when overall health changes or a backup fails. Use
either a Slack-compatible webhook, Telegram, or both:

```dotenv
OPS_ALERT_WEBHOOK_URL=
OPS_TELEGRAM_BOT_TOKEN=
OPS_TELEGRAM_CHAT_ID=
```

After editing `.env`, restart the timers' next run or trigger a check:

```bash
systemctl --user start agentic-os-monitor.service
```

Do not commit notification tokens. They remain in the server `.env`.

## Useful commands

```bash
systemctl --user list-timers --all | grep agentic-os
systemctl --user status agentic-os-monitor.service
systemctl --user status agentic-os-backup.service
python3 scripts/agentic-os-operations.py status
npm run prod:e2e
```

`npm run prod:e2e` is a read-only production smoke test. Set
`AGENTIC_OS_PUBLIC_URL`, optional `AGENTIC_OS_INTERNAL_URL`, and
`AGENTIC_OS_TOKEN` or `AUTH_TOKEN` to include the protected operational checks.

## Four C readiness audit

The Observability page combines host operations with a live readiness audit:

- **Context:** onboarding, workspace goals and synchronized Obsidian notes.
- **Connections:** Hermes, Obsidian MCP, MILA and configured integrations.
- **Capabilities:** the five-agent Hermes fleet, Claude Workspace, MILA voice and Kanban execution history.
- **Cadence:** host monitoring, incidents, backups, restore drills and scheduled agent work.

The audit is calculated on the server by `server/lib/readiness.js`. External probes
run in parallel with bounded timeouts, failures become explicit failed checks, and
credentials are never returned. Each failed check includes a dashboard route for
the next corrective action.

When adding a new operational dependency, extend the snapshot in
`readFourCReadiness()`, add a bounded check in `buildFourCReadiness()`, and cover
both healthy and degraded behavior in `test/readiness.test.js`.
