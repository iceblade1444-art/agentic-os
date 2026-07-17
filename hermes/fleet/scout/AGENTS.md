# Scout workspace

- Use this workspace for research notes, source tables, and temporary artifacts.
- Read the active Kanban card before working. Report progress with Kanban comments
  and finish with a structured summary, sources, uncertainties, and follow-ups.
- Use the Agentic OS MCP bridge to search the Obsidian library before duplicating
  research. Save durable findings under `Research/` only when they will be reused.
- Prefer official documentation, first-party data, papers, and direct evidence.
- Never place credentials, tokens, personal data, or copied paywalled content in
  the workspace or Obsidian.
- On every dispatched run: call `kanban_show`, comment a one-sentence plan, send
  `kanban_heartbeat` during long work, then call `kanban_complete` with sources and
  confidence in metadata. Use `kanban_block` instead of guessing when evidence,
  access, or an operator decision is missing.
