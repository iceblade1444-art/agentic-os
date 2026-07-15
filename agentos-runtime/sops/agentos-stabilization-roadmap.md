# AgentOS Stabilization Roadmap

Status: locally verified
Owner: Orchestrator
Updated: 2026-06-22

## Mission

Turn this local-first AgentOS workspace into a dependable working system where a user can give one goal, review the plan, approve risky actions, and receive verified artifacts with logs, memory updates, and a final report.

## Operating Principles

- Local-first by default.
- No secrets in dashboard HTML, reports, launchers, JSON configs, or generated artifacts.
- Risky external actions require explicit approval.
- Every meaningful run should produce a run id, event log entries, artifacts, and a human-readable report.
- Dry-run and preview modes stay available for testing before live execution.

## Phase 1: Baseline And Protection

1. Confirm whether the workspace is version controlled.
2. If no repository exists, create a backup or initialize Git before broad edits.
3. Run release readiness checks.
4. Run focused tests for CLI, dashboard, queue, approvals, voice, and artifact generation.
5. Record failures in `logs/daily/` with exact commands and outcomes.

## Phase 2: Control Plane

1. Make `agentosctl.py` the canonical command entry point.
2. Ensure every goal follows the same flow: goal -> plan -> tasks -> approval -> execution -> QA -> report.
3. Keep worker daemon defaults conservative: dry-run, one item per tick, approval required.
4. Add or maintain clear task states: planned, approved, running, blocked, done, failed.

## Phase 3: Tool And Permission Registry

1. Catalog tools by name, input, output, risk level, credentials, and approval requirement.
2. Separate read-only tools from write/action tools.
3. Add preflight checks for missing credentials, missing folders, unavailable providers, and disabled services.
4. Ensure dashboard endpoints never return raw secrets.

## Phase 4: Memory And Context

1. Keep markdown memory files human-readable.
2. Add structured summaries or indexes for projects, decisions, user profile, business context, and SOPs.
3. Update memory only after successful runs or explicit user instruction.
4. Add retention rules for large traces, logs, and generated smoke artifacts.

## Phase 5: Observability

1. Ensure every queue run has a run id and artifact path.
2. Surface health in the dashboard: worker status, pending approvals, latest error, latest artifact, latest event.
3. Preserve runtime traces for debugging.
4. Add retention and archive paths for old traces.

## Phase 6: Voice And Mila

1. Keep local-file voice provider as the reliable fallback.
2. Treat Gemini Live as optional until credentials and transport checks pass.
3. Route voice commands through the command bridge and approval gates.
4. Keep Mila dashboard controls secret-free and local-first.

## Phase 7: Golden End-To-End Demo

The first release demo should prove:

1. A user gives one goal.
2. Orchestrator creates a plan and task cards.
3. A safe artifact is generated under `projects/` or `artifacts/`.
4. QA verifies the artifact.
5. Dashboard reflects status.
6. Logs and final report are written.
7. No secrets leak.

## Current Known Baseline

- Workspace exists at `C:\Users\User\AgentOS`.
- Main entry points exist: `agentosctl.py`, `dashboard/backend/app.py`, `dashboard/frontend/index.html`.
- Core folders exist: `agents`, `approvals`, `artifacts`, `config`, `dashboard`, `logs`, `memory`, `projects`, `scripts`, `tests`, `voice`, `workflows`.
- The workspace is version controlled and has a baseline commit.
- `python agentosctl.py release check --pretty` reports `ready_local`.
- The local dashboard responds at `http://127.0.0.1:8765/`.
- Golden demo `python agentosctl.py run-demo landing-page` reports `pass`.
- Focused stabilization tests pass.

## Phase Status

| Phase | Status | Evidence |
|---|---|---|
| 1. Baseline And Protection | verified | Git baseline exists; release check is `ready_local`; dashboard responds |
| 2. Control Plane | documented | `sops/control-plane-contract.md` |
| 3. Tool And Permission Registry | documented and test-covered | `config/tool-registry.json`; `tests/test_stabilization_artifacts.py` |
| 4. Memory And Context | indexed and test-covered | `memory/index.json`; `tests/test_stabilization_artifacts.py` |
| 5. Observability | verified | worker status, queue runs, trace storage summary, events API |
| 6. Voice And Mila | verified | voice health ready; local-file fallback ready; Gemini configured by env; Mila model hub and visual polish endpoints secret-safe |
| 7. Golden End-To-End Demo | verified | `run-demo landing-page` passes and preserves demo `created_at` |

## Next Hardening Pass

1. Commit the stabilization artifacts and idempotent demo fix.
2. Add a dashboard link or panel for the tool registry.
3. Add a CLI command to print the tool registry and memory index.
4. Add bounded event-log pagination to avoid huge `/api/events` responses.
5. Build the next golden demo around a real user goal, not only the AI SEO sample.
