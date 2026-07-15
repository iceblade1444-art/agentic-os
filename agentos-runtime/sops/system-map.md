# AgentOS System Map

Status: active
Updated: 2026-06-22

## Live Components

| Component | Path | Status | Role | Notes |
|---|---|---|---|---|
| CLI control plane | `agentosctl.py` | working | Canonical command entry point | Release check and demo verified locally. |
| Dashboard backend | `dashboard/backend/app.py` | working | Local HTTP API | Serves status, readiness, queue, worker, voice, Mila, and runtime endpoints. |
| Dashboard frontend | `dashboard/frontend/index.html` | working | Mission Control UI | Browser check showed the Agentic OS shell loads without console errors. |
| Orchestrator | `agents/orchestrator.md` | working | Goal planning and routing | Owns goal -> plan -> tasks -> approval -> execution -> QA -> report. |
| Specialist agents | `agents/*.md` | working | Coding, content, QA, email roles | Role specs exist; least-privilege contract is defined separately. |
| Agent registry | `agents/registry.json` | working | Truth table for real/provider/ui-only/planned agents | Inspired by Hermes multi-agent workflow config-driven roles and board-as-bus pattern. |
| Agent queue | `agents/queue.json` | working | Queue state | Live runtime file; may change during dashboard and worker activity. |
| Approval queue | `approvals/approvals.json` | working | Approval records | Dashboard reported pending and approved approval records. |
| Project workspaces | `projects/` | working | Project files and task cards | 47 projects reported by status API during verification. |
| Durable memory | `memory/*.md` and `memory/index.json` | working | Human-readable memory plus structured index | Markdown remains source of truth; JSON index added. |
| Voice layer | `voice/`, `config/voice.json`, `config/voice.local.json` | working | Mock, local-file, Gemini Live providers | Voice health reported all providers ready; local-file sample verified. |
| Tool registry | `config/tool-registry.json` | working | Risk and permission catalog | Added and covered by tests. |
| Worker config | `config/agent-worker.json` | disabled-safe | Worker daemon guardrails | Disabled, dry-run, one item per tick, approval required. |
| Runtime logs | `logs/` | working | Events, queue logs, daily reports | Event API and queue run history verified. |
| Runtime traces | `artifacts/agent-worker/runtime-traces` | working | Trace export, archive, pruning | Storage summary and retention links verified. |
| Generated artifacts | `artifacts/` and `projects/*` | working | Deliverables and reports | Golden landing-page demo verified. |
| Installers/launchers | `scripts/`, `installers/` | working | Local startup helpers | Release tests verify launcher references and no embedded API keys. |
| Tests | `tests/` | working | Regression and smoke coverage | Full suite passed: 384 tests. |

## Status Classes

- `working`: verified by tests, release check, API probe, or browser check.
- `disabled-safe`: intentionally off by default with guardrails.
- `partial`: exists but needs more implementation before relying on it.
- `demo-only`: useful for proof of concept but not a production workflow.
- `unsafe until approved`: can create external side effects and must stop at approval.

## Current Runtime Notes

- Live dashboard and voice checks can update `agents/queue.json`, `logs/events.json`, and project task files.
- These runtime-state changes should be reviewed separately from code and SOP changes.
- `.env` must remain local and uncommitted.
