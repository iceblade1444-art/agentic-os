# Claude Code workspace

Claude Code is the interactive engineering workspace inside Agentic OS. It is
not the primary orchestrator and it does not replace the persistent Hermes
fleet.

## Responsibility

- inspect and change code inside the selected `/app/work` project;
- keep a persistent, resumable coding conversation;
- run focused checks and summarize changed files and remaining risk;
- attach source files and project context to the coding session;
- delegate research, writing, growth, engineering, or orchestration work to the
  shared Hermes Kanban when a specialist is useful.

## Collaboration map

- `default` / Hermes: plans and coordinates multi-agent goals;
- `scout`: primary-source research and technical comparison;
- `scribe`: documentation, release notes, copy, and structured writing;
- `reach`: positioning, launch, growth, and monetization work;
- `dev`: isolated engineering subtasks and verification;
- Claude Code: the user-facing coding workspace that assembles and reviews the
  engineering result.

Every handoff must create a visible Kanban task. Claude Code remains responsible
for integrating the result into the active project and reporting verification.
