# Retention And Secret Safety

Status: active
Updated: 2026-06-22

## Retention Goals

Keep enough local history to debug AgentOS while preventing logs, traces, transcripts, and generated smoke artifacts from growing forever.

## Retention Policy

| Data | Location | Default Handling |
|---|---|---|
| Daily reports | `logs/daily/*.md` | Keep; summarize older waves when volume becomes noisy. |
| Event log | `logs/events.json` | Keep, but add bounded API pagination/latest-only defaults. |
| Queue run history | `logs/agent-queue/runs.json` | Keep run ids, summaries, artifact paths, and log paths. |
| Queue logs | `logs/agent-queue/**` | Archive or prune old smoke logs after reports are generated. |
| Runtime traces | `artifacts/agent-worker/runtime-traces` | Use archive/pruned paths and retention preview before deletion. |
| Voice transcripts | `voice/transcripts/*.json` | Keep only useful transcripts; prune mock/test transcripts after summary. |
| Generated smoke projects | `projects/wave-*`, `projects/*smoke*` | Archive or remove only after report and approval. |
| Generated artifacts | `artifacts/**` | Keep linked artifacts; prune orphaned smoke artifacts after review. |

## Required Before Deletion

Before deleting or pruning:

1. Confirm the item is not linked from an active project, report, approval, or queue run.
2. Prefer archive over delete.
3. Record what changed in a daily report.
4. Require approval for destructive cleanup outside clearly marked generated smoke data.

## Secret Safety Checks

Never expose raw values from:

- `.env`
- process environment variables
- provider credentials
- browser/session tokens
- personal inboxes

Safe responses may include only:

- whether a key exists;
- which environment variable name is expected;
- whether a provider is ready;
- redacted or presence-only diagnostics.

## Known Hardening Work

- Event-log pagination/latest defaults are implemented for `/api/events`.
- Broad secret-leak regression coverage exists for key dashboard responses and generated report previews.
- Add a retention command that previews before applying.
- Add dashboard cards for retention status and storage pressure.
