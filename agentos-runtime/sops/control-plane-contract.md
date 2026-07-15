# AgentOS Control Plane Contract

Status: active
Owner: Orchestrator
Updated: 2026-06-22

## Canonical Entry Point

`agentosctl.py` is the canonical local command entry point for AgentOS operations. Dashboard actions and voice commands should route through the same command bridge or equivalent control-plane functions rather than bypassing safety checks.

## Goal Lifecycle

Every user goal should move through this sequence:

1. `goal` - capture the exact user request and project slug.
2. `plan` - produce a brief with assumptions, risks, acceptance criteria, and expected artifacts.
3. `tasks` - create task cards with owners, dependencies, risk level, approval requirement, and artifacts.
4. `approval` - stop before any risky external action until an approval record is approved.
5. `execution` - perform low-risk local work or approved work only.
6. `QA` - verify acceptance criteria with concrete checks.
7. `report` - save a human-readable result with artifacts, evidence, blockers, and next action.
8. `memory` - update durable memory only after success or explicit user instruction.

## Task State Model

Allowed task states:

- `planned` - task is defined but not started.
- `approved` - required approval exists and is approved.
- `running` - task is actively being worked.
- `blocked` - task cannot continue and has `block_reason`.
- `done` - acceptance criteria passed or artifact exists.
- `failed` - attempted work did not pass QA.

Compatibility note: existing historical tasks may use older states. New control-plane code and new task cards should use the allowed states above.

## Worker Safety Defaults

The worker daemon must default to:

- disabled unless explicitly enabled;
- `runtime_mode: dry_run`;
- `dry_run: true`;
- `max_items_per_tick: 1`;
- approval required for live execution.

## Completion Rule

A run is complete only when one of these is true:

- all required task acceptance criteria are verified and artifacts are saved;
- remaining tasks are explicitly blocked with reasons and a report explains the blocker.

## Dashboard Rule

Dashboard endpoints may display state and create safe local records, but they must not return raw secrets or perform high-risk external actions without approval.
