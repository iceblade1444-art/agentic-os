# The Command Center (the operator's home)

The old Operational Home dissolved into the Command Center in Ф4 of
`COMMAND_CENTER_OS_PLAN_RU.md`. `#/` (and its alias `#/command`) is a stage,
not a page: modules orbit a data-driven galaxy between the day's vitals, and
the day's operations happen in overlays ("sheets") without leaving it. The
Second Brain map lives at `#/command/map`. Everything renders from
server-authoritative APIs; there are no generated demo metrics.

## What lives where

- **Panels** (left: micro apps, calendar, memory + factory; right: inbox,
  skills deck, routines) show the headline numbers.
- **Sheets** — deep-linkable as `#/command/sheet/<name>` — carry the actions:
  `inbox` (approve/deny), `today` (personal tasks, done in place), `routines`
  (trigger/pause/resume), `note` (read + append), `skill` (content, toggle,
  run), `systems` (services, host, backup, database health), `erp` (the full
  factory cut). Opening a sheet never rebuilds the stage; Esc closes and
  returns focus to the opener.
- **The galaxy and the map are the vault**: clusters and sectors are real
  folders sized by note counts (`/api/knowledge/graph`), dots are real notes,
  lines are real links. The centre search (Enter) federates everything through
  `/api/brain/search`.

## Sources

- Needs-you queue and approvals: `/api/needs-you`, `/api/pulse`
- Work queue and fleet: `/api/kanban/board`
- Recurring work: `/api/routines`
- Vault: `/api/knowledge/status`, `/api/knowledge/graph` (cached 5 min —
  walking the vault costs file reads)
- Skills: `/api/skills` (the deck's ▶ creates a ready Kanban task)
- Factory: `/api/erp` (cached 3 min — one GET runs eight live MCP tools),
  digested by `erpDigest()` shared with the ERP page
- Ops detail behind the LED row: `/api/operations/status`, `/api/health`
- Universal search: `/api/brain/search` — one query across notes, tasks,
  chats, missions, routines, skills, studio, memory and live ERP; the reply
  names which sources answered and admits when it is partial

## Behaviour

Every source loads through bounded `Promise.allSettled()` calls: a dead
runtime costs its own panel, never the stage, and reads as a stated state
("Недоступен"), never as zeros. Vitals refresh every 45 seconds while
mounted — but never underneath an open search or sheet. The canvas scenes cap
at 30 fps, pause when the tab is hidden, and hold still under
`prefers-reduced-motion`. The stage keeps its own black-and-ember palette in
both themes; the rest of the operator surface renders it through the
`command` theme in `tokens.css` (an operator's stored "dark" maps to it at
apply time — Member and Design keep the original themes).

Mutations beyond the sheets' own actions remain in Kanban, Routines, Skill
Studio, Integrations and Observability, where their normal confirmation rules
apply.
