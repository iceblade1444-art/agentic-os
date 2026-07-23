# Skill Studio

Skill Studio is the Agentic OS interface for Hermes procedural memory. It does
not maintain a second skill database. Every list, toggle, read, write and Hub
installation is performed against the active Hermes profile.

## Data flow

1. The browser calls the authenticated `/api/skills` routes.
2. `server/routes/skills.js` validates and bounds user input.
3. `server/lib/hermes-kanban.js` obtains the private Hermes Dashboard session
   token over the server-side bridge.
4. Hermes reads or updates its source of truth under `~/.hermes/skills/`.
5. The browser receives metadata or skill content, never the Hermes session
   token.

Creator and Admin users may create, edit, toggle and install skills. Bundled and
Hub skills are read-only in the Agentic OS editor because their source owns
updates. Custom `agent` skills can be edited directly.

## Skill authoring

Each skill requires a `SKILL.md` with YAML frontmatter. Keep the description
short and make the procedure verifiable:

```markdown
---
name: deployment-audit
description: Verify a deployment and report operational risks
version: 1.0.0
metadata:
  hermes:
    tags: [deployment, operations]
    category: operations
---

# Deployment Audit

## When to Use
## Procedure
## Pitfalls
## Verification
```

Use a skill for reusable instructions that Hermes can execute with existing
tools. Build a tool or MCP integration when the capability requires secrets,
strict custom logic, binary data, streaming or a dedicated authentication flow.

## Extension points

- Add profile-aware UI behavior in `assets/js/pages/misc.js`.
- Add bounded Hermes endpoints only through `hermesSkillsRequest()`.
- Keep write routes protected by `requireRoles("Creator", "Admin")`.
- Add connector and frontend contract tests in `test/kanban.test.js`.
