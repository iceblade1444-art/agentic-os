# Access control and workspace data

Agentic OS uses one shared team workspace and separate personal browser state.

## Roles

| Role | Shared workspace | Create and run work | System configuration | Manage users |
| --- | --- | --- | --- | --- |
| Creator | Read and write | Yes | Yes | Yes |
| Admin | Read and write | Yes | Yes | Yes |
| Member | Read and write | Yes | No | No |
| Viewer | Read only | No | No | No |

System configuration includes MCP server management, integration credentials and
Secrets. Creator is the server owner configured through `CREATOR_NAME`,
`CREATOR_EMAIL` and `AUTH_TOKEN`. Creator cannot be disabled from the web panel.

Public registration is controlled by `ALLOW_REGISTRATION`. A new account always
starts as Member. Creator or Admin can later change it to Admin, Member or Viewer
in **Settings > Team**. Changing a role or disabling an account invalidates that
account's existing browser sessions.

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
