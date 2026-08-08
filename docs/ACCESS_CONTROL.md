# Access control and workspace data

Agentic OS uses one shared team workspace and separate personal browser state.

## Roles

| Role | Shared workspace | Create and run work | Studio | ERP | System configuration | Manage users |
| --- | --- | --- | --- | --- | --- | --- |
| Creator | Read and write | Yes | Yes | Read and act | Yes | Yes |
| Admin | Read and write | Yes | Yes | Read and act | Yes | Yes |
| Design | Personal only | Personal only | Yes | Read only | No | No |
| Member | Read and write | Yes | No | Read only | No | No |
| Viewer | Read only | No | No | Read only | No | No |

System configuration includes MCP server management, integration credentials and
Secrets. Creator is the server owner configured through `CREATOR_NAME`,
`CREATOR_EMAIL` and `AUTH_TOKEN`. Creator cannot be disabled from the web panel.

Each role gets its own set of panels in the sidebar:

- **Creator and Admin** — the full operator surface, including Hermes, Agents,
  Kanban, Missions, Routines, Context (Memory, MCP, Integrations), Studio
  (Design, Media, Analytics, ERP) and Operate (Evaluations, Observability,
  Guardrails, Secrets).
- **Design** — the member surface plus **Studio**: Design, Media and the Obsidian
  library. Analytics signals and the Higgsfield account connection stay with
  operators, so a Design account produces creative work but does not own the
  integration or the business metrics.
- **Member** — ERP (the landing page), Personal, Mila Assistant, Mila Live, Inbox,
  My Tasks, My Notes and Settings.
- **Viewer** — the Member panels, read only.

**ERP** is readable by every signed-in role: the snapshot (`GET /api/erp`) and the
read tools, including `erp_search`, are open so anyone on the team can look up
orders, stock, production and finance numbers. Tools that change something in the
ERP itself (`erp_create_task`, `erp_send_notification`) and the Obsidian
`wiki-sync` return `403` for anyone below Admin. Member is the only role ERP is
the *landing page* for — Design keeps its own dashboard at `#/` and reaches ERP
through a regular nav entry instead.

**Mila Live** (voice) is open to Member too, but scoped to conversation only.
`GET /api/integrations/mila/status`, `POST .../voice-token`, `.../livekit-token`
and `.../chat` carry no role gate — any signed-in user can start a call or send a
written turn. Everything else under `/api/integrations` (provider credentials,
Slack send, `mila/devices`, `mila/connection-code`, `mila/subscription`,
`mila/app-update`) still requires `requireAdmin`. Inside a call, the model may
only invoke `get_erp_business_context` and `get_finished_goods_stock`
(`server/routes/mila-actions.js`'s `READ_ONLY_ERP_ACTIONS`) — `create_kanban_task`,
`delegate_to_hermes`, `write_obsidian_note`, `ask_claude_code`, `call_mcp_tool` and
the Kanban/Obsidian/Claude/MCP read actions all `403` for anyone who is not Creator
or Admin, regardless of what the client asked for. The browser mirrors this by
declaring a smaller tool list to the model for non-operators
(`assets/js/mila-tools.js`'s `MILA_MEMBER_TOOLS`), but that is UX polish, not the
security boundary — the boundary is the server-side check.

Creator and Admin accounts can enable TOTP MFA in **Settings > Security**.
Password validation happens before a short-lived MFA challenge, and no web or
mobile session is created until that challenge succeeds. TOTP secrets are
encrypted at rest; recovery codes are stored only as HMAC digests. See
[`MFA_SETUP_RU.md`](MFA_SETUP_RU.md).

Public registration is controlled by `ALLOW_REGISTRATION`. A new account always
starts as Member. Creator or Admin can later change it to Admin, Design, Member
or Viewer in **Settings > Team**. Changing a role or disabling an account
invalidates that account's existing browser sessions.

## Owner approval

`REQUIRE_ACCOUNT_APPROVAL` is on by default: registration creates the account but
issues no session, and the person cannot sign in until Creator or Admin approves
them in **Settings > Team**. The Team tab shows a banner while anyone is waiting.

- Registration answers `{ ok: true, approvalRequired: true }` and sets no cookie.
- Web and mobile sign-in answer `403 { code: "approval_pending" }`.
- `sessionUser()` returns null for a pending account in both the JSON store and
  the PostgreSQL read adapter, so a pending account cannot hold a session at all.
- Approving or revoking writes an `account.update` audit entry; revoking also
  bumps `sessionVersion`, which kills any session the account already had.

Accounts created before this gate existed have no `approvedAt` and stay approved,
so enabling the flag never locks out the current team. To put an existing account
behind the gate, press **Отозвать / Revoke** next to it in **Settings > Team**.

## Data boundaries

Shared team data lives on the server and is intentionally visible to the team:

- Kanban tasks, task logs, attachments and agent activity;
- Hermes and Claude workspace sessions;
- the Obsidian knowledge vault;
- missions and shared orchestration state;
- MCP and integration configuration (administration is restricted).

Personal UI data stays in the current browser under
`agentic-os:v1:<authenticated-user-id>`. It includes chat history, appearance,
local agent drafts and UI preferences. The old unscoped `agentic-os:v1` data is
migrated once to the Creator account so an upgrade does not erase the owner's
existing browser state.

## Passwords and sessions

Registered users are stored in `DATA_DIR/users.json`. Passwords are never stored
directly: Agentic OS saves a random salt and a Node.js `scrypt` hash. The file is
written with owner-only permissions where supported. Browser sessions are signed,
HttpOnly, SameSite cookies. In production keep `SECURE_COOKIE=true` and use HTTPS.

API clients that use `Authorization: Bearer AUTH_TOKEN` act as Creator. This keeps
the existing Hermes and MCP bridges compatible. Never expose that token to a
browser, repository, log or screenshot.
