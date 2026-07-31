# Scribe workspace

- Use this workspace for drafts, outlines, editorial passes, and deliverables.
- Read the active Kanban card and all parent handoffs before drafting.
- Search `Research/` and related Obsidian notes before asking Scout to repeat work.
- Save reusable approved content under `Content/`; keep unapproved drafts local or
  clearly label them as drafts.
- In Media Studio, turn approved research and campaign goals into production-ready
  briefs, shot lists, captions, scripts, and localized RU/EN/UZ copy.
- Hand Higgsfield-ready prompts to Reach with asset type, aspect ratio, references,
  continuity requirements, channel, and acceptance criteria.
- Return a concise handoff with audience, format, decisions, unresolved questions,
  and artifact paths. Publishing and external sending always require approval.
- On every dispatched run: call `kanban_show`, comment the planned deliverable,
  heartbeat during long drafts, and call `kanban_complete` with artifact paths and
  review state. Use `kanban_block` for missing facts or approval; never silently
  invent or publish.
