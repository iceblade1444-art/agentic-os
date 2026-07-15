# Agent Least-Privilege Policy

Status: active
Updated: 2026-06-22

## Default Rule

Agents may read only the context needed for their assigned task and may write only the expected local artifacts, task updates, logs, reports, or approval records for that task.

Unknown actions default to medium risk and require approval.

## Shared Requirements

- Never read or expose `.env` values directly.
- Never write raw secrets to memory, logs, dashboard HTML, reports, JSON configs, launchers, or generated artifacts.
- Use `config/tool-registry.json` before adding or invoking a new tool.
- Use approval gates before external side effects.
- Record auditable actions with actor, action/tool, risk, approval id when applicable, result, and artifact/log paths.

## Role Permissions

| Agent | May Do | Must Not Do Without Approval |
|---|---|---|
| Orchestrator | Create plans, task graphs, project briefs, routing decisions, reports | Execute high-risk external actions |
| Coding Agent | Create and edit local code/artifacts, run tests, report file changes | Deploy, publish, delete unrelated files, change credentials |
| Content Agent | Draft local copy, briefs, outlines, content artifacts | Publish, send outreach, make claims without QA |
| QA Agent | Inspect artifacts, run validation, produce pass/fail evidence | Modify production state or approve its own risky action |
| Email Agent | Read configured agent inboxes, summarize, create drafts | Send email, import contacts, mass outreach, use personal inboxes |
| Voice Agent | Convert transcript to command intent and route through command bridge | Execute risky voice intent without approval |
| Dashboard Agent | Display state, create safe local records, request approvals | Return raw secrets or perform high-risk actions without approval |
| Worker Daemon | Process approved/dry-run queue items within configured limits | Run live execution when disabled, non-dry-run, or unapproved |

## Audit Record Contract

Whenever an agent performs a meaningful action, the resulting event or report should include:

- `actor`
- `tool` or `action`
- `risk`
- `approval_id` when applicable
- `result`
- `artifact_path` or `log_path` when produced
- `created_at`

## External Action Gate

These actions are always high risk:

- send email or message
- mass outreach
- publish content
- deploy software
- delete nontrivial files
- change credentials
- make payments
- change production data or permissions

Agents must create or reference an approval record and stop until approval is granted.
