# Agentic OS Release Readiness

Last verified: 2026-07-28

## Current release

Agentic OS is deployed at:

- Public: `https://agent.milanapremium.uz`
- Internal: `http://172.16.10.6:8787`
- Source: `https://github.com/iceblade1444-art/agentic-os`
- Mobile source: `https://github.com/iceblade1444-art/mila-agent`

The web application, GitHub `main`, and the server deployment must always point
to the same commit before a release is considered complete.

## Product map

### Creator and operators

- Operational Home with live service readiness
- Hermes Agent control and five persistent profiles
- Hermes Kanban, native Cron routines, and Skill Studio
- Claude Workspace with bounded project files and Hermes delegation
- MILA Live with Gemini audio-to-audio voice and Agentic OS tools
- Obsidian library, search, graph, and audited agent usage
- MCP, integrations, evaluations, observability, guardrails, and secrets
- User, role, session, MFA, backup, and restore controls

### Members

- Separate navigation and route allowlist
- Personal home, Personal workspace, MILA chat, tasks, notes, and settings
- No access to operator pages or privileged APIs
- Per-user task and note storage
- Per-user onboarding profile and `SOUL.md`
- RU, EN, and UZ interface selection stored with the server profile
- Password change, MFA, session revocation, personal export, and account deletion

### Mobile MILA

- The same Agentic OS account identity as the web application
- Web/mobile login and registration contracts
- MFA challenge support
- One-time pairing grants
- Private LiveKit rooms and secure server-issued voice tokens
- Personal tasks, notes, profile, and SOUL remain server-authoritative

## Data and security

- PostgreSQL is the production source of truth.
- JSON is retained only as the bounded write-ahead rollback layer.
- Member and authentication writes require a PostgreSQL commit.
- Passwords are scrypt hashes; plaintext passwords are never stored or listed.
- Sessions are tracked per device and revoked after password changes or deletion.
- Member workspaces are scoped by authenticated user ID.
- Creator/Admin APIs are protected by server-side role checks.
- Secrets stay encrypted or server-side and are excluded from public telemetry.

## Verified checks

- Node test suite: 181 passed, 1 intentionally skipped, 0 failed.
- Flutter test suite: 18 passed, 0 failed.
- Android release build: successful.
- Public SPA and health production E2E: successful.
- Real production Member smoke:
  - registration and web session;
  - personal dashboard, task, note, and SOUL;
  - operator API rejected with HTTP 403;
  - mobile login resolves to the same user;
  - task and note visible through the mobile bearer session;
  - account deletion revokes the mobile session and removes test data.
- PostgreSQL primary reads/writes, outage rollback, parity, backup, and restore drill:
  successful.

## Release commands

```powershell
# Web and server tests
npm test
npm run prod:e2e

# Mobile tests and Android release build
& 'C:\FlutterSDK\bin\flutter.bat' test
& 'C:\FlutterSDK\bin\flutter.bat' build apk --release
```

Android output:

`C:\AI Agent\mila\build\app\outputs\flutter-apk\app-release.apk`

## Remaining external configuration

Password-reset and email-verification code is implemented, but production email
delivery is not configured. Until SMTP is configured:

- registration remains available because email verification is optional;
- users cannot receive password-reset links by email;
- the login screen hides the unavailable recovery action.

Configure these server-only values and restart the application:

```dotenv
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM="Mila Agentic OS <no-reply@example.com>"
EMAIL_VERIFICATION_REQUIRED=true
```

Do not commit real SMTP credentials to Git. After configuration, verify that
`/api/health` reports `accountRecovery.deliveryReady: true`, then test
registration confirmation and password reset with a real mailbox.

