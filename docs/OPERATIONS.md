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

Before opening registration to users, run:

```bash
npm run prod:member-e2e
```

The check creates two temporary Member accounts, verifies the same identity
through web and mobile login, proves personal task isolation, verifies the
per-user SOUL export, and removes both accounts. It never uses the Creator
credential.

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

## Off-site copies

A backup on the same disk as production is not a backup: one disk failure takes
the data and every copy of it at once. Configure both values in `.env`:

```dotenv
OPS_BACKUP_PASSPHRASE_FILE=/home/admilana/.config/agentic-os/backup.pass
OPS_BACKUP_REMOTE=s3:my-bucket/agentic-os     # or a directory on another disk
OPS_OFFSITE_MAX_AGE_HOURS=36
```

Create the passphrase file so only its owner can read it, and **store a second
copy of that passphrase somewhere other than this server** — the archives cannot
be recovered without it:

```bash
mkdir -p ~/.config/agentic-os
openssl rand -hex 32 > ~/.config/agentic-os/backup.pass
chmod 600 ~/.config/agentic-os/backup.pass
```

After each successful backup the whole timestamped directory is sealed with
`gpg` (symmetric AES-256) into `<stamp>.tar.gz.gpg` and copied to the remote. A
remote written as `name:path` goes through `rclone`; anything else is treated as
a directory, which covers a second disk or an NFS mount without extra tools.

Two properties are deliberate. Setting `OPS_BACKUP_REMOTE` without a passphrase
is **refused**, because the archive contains the server `.env` with every
provider credential. And a failure here never fails the local backup: the local
copy stays a success, `offsite` records the error, and an alert is sent.

The monitor reports `offsite` as degraded when nothing is configured, so an
install with no second copy says so rather than looking healthy.

## Restoring from a backup

The drill below proves an archive is readable; this is the procedure for an
actual restore. Do it on a fresh host or after stopping the stack.

```bash
# 1. Fetch the sealed archive (skip if restoring from the local directory)
rclone copy s3:my-bucket/agentic-os/20260817T031500Z.tar.gz.gpg .

# 2. Decrypt and unpack
gpg --batch --decrypt --passphrase-file ~/.config/agentic-os/backup.pass \
  20260817T031500Z.tar.gz.gpg > backup.tar.gz
tar -xzf backup.tar.gz

# 3. Stop the stack before replacing state
cd ~/agentic-os && docker compose down

# 4. Restore the application state and the vault
tar -xzf 20260817T031500Z/data.tgz -C ~/agentic-os
tar -xzf 20260817T031500Z/vault.tgz -C ~/agentic-os
tar -xzf 20260817T031500Z/agentos-runtime.tgz -C ~/agentic-os
cp 20260817T031500Z/.env ~/agentic-os/.env && chmod 600 ~/agentic-os/.env

# 5. Check out the commit the backup was taken from
git -C ~/agentic-os checkout "$(cat 20260817T031500Z/git-head)"

# 6. Bring PostgreSQL up alone, then load its dump
docker compose up -d postgres
docker exec -i agentic-os-postgres pg_restore -U agentic_os -d agentic_os \
  --clean --if-exists < 20260817T031500Z/postgres.dump

# 7. Start everything and verify
bash deploy.sh
curl -fsS "$(sed -n 's/^OPS_HEALTH_URL=//p' .env)" | head -40
```

`SESSION_SECRET` in the restored `.env` must be the one the backup was taken
with. It derives the encryption keys for MFA secrets, governance secrets and
Google tokens — restoring data under a different value leaves all of it
unreadable and logs everyone out.

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

### Standalone speech service

Production may run the `speech` container from a dedicated Compose project so
large speech models are not rebuilt during normal Agentic OS releases.
`deploy.sh` detects the Compose project label on the existing `speech`
container. When another project owns it, the release reuses that container and
updates only PostgreSQL, AgentOS runtime, and the web application. Run speech
image rebuilds from the standalone speech project instead of setting
`REBUILD_SPEECH=true` in the Agentic OS project.

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
