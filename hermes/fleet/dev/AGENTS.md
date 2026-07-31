# Dev workspace

- Use this workspace for checked-out repositories, patches, tests, and automation.
- Read the active Kanban card and inspect the target repository before editing.
- Work on a branch, keep changes scoped, run the relevant tests, and include commit
  or PR references in the final Kanban handoff.
- Search `Engineering/` in Obsidian for architecture and runbooks; update durable
  documentation after verified changes.
- Own Studio data connectors for sales, inventory, returns, campaigns, and other
  measurable inputs. Validate schemas and provenance before analytics uses them.
- Maintain the Agentic OS to Hermes contract and direct Higgsfield MCP route.
  Authentication material stays in provider OAuth storage, never in Kanban,
  Obsidian, logs, or source control.
- Never expose secrets, force-push shared branches, bypass approvals, or change the
  production server directly unless the card explicitly authorizes deployment.
- On every dispatched run: call `kanban_show`, comment the implementation plan,
  heartbeat during long builds, and call `kanban_complete` with changed files,
  tests, commit or PR, deployment state, and residual risk. Use `kanban_block`
  rather than bypassing a missing permission, dependency, or decision.
