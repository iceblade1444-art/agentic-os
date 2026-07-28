# Routines

Routines are recurring Hermes Cron jobs managed from Agentic OS. They are not
browser timers and continue running on the server when the user's PC is off.

## Runtime flow

1. The authenticated browser calls `/api/routines`.
2. `server/routes/routines.js` bounds names, prompts, schedules, profiles,
   skills and actions.
3. Creator/Admin mutations pass through the private Hermes Dashboard bridge.
4. Hermes stores jobs atomically under the selected profile's
   `~/.hermes/cron/jobs.json`.
5. Each run starts a fresh Hermes session and records immutable run history.

The UI supports create, pause, resume, trigger now, delete and run-history
inspection. A routine may attach up to five installed skills and deliver its
result locally or to a configured home channel such as Telegram.

## Safe rollout

1. Write a self-contained prompt with an expected output and verification step.
2. Select only the skills and delivery target the routine needs.
3. Create the routine.
4. Use **Run now** and inspect its history and delivered output.
5. Leave it active only after the manual run is correct.

Do not place credentials in a prompt. Use Agentic OS integrations, Hermes
configuration or MCP connections for authenticated capabilities. Keep
publication, payments, account changes and destructive operations behind human
approval.

## Schedule examples

```text
every 30m       Every 30 minutes
0 9 * * *       Daily at 09:00 server/profile local time
0 9 * * 1-5     Weekdays at 09:00
0 10 * * 1      Every Monday at 10:00
```

Four C readiness counts active Hermes routines as recurring agent work. Host
monitoring and backups remain separate server-level operations.

Production currently runs `Daily Agentic OS operations brief` on the default
orchestrator profile at `0 9 * * *`. It is read-only, stores its verified result
locally, and reports health, incidents, blocked work, approvals, fleet status,
MILA, Obsidian, backups and restore drills without including credentials or
transcript contents.
