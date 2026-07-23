# Operational Home

Operational Home is a read-only live overview assembled from existing
server-authoritative APIs. It intentionally contains no generated demo metrics.

## Sources

- Four C readiness, incidents and backups: `/api/operations/status`
- Work queue and fleet: `/api/kanban/board`, `/api/kanban/profiles`
- Recurring work: `/api/routines`
- Knowledge state and activity: `/api/knowledge/status`, `/api/knowledge/usage`
- Procedural capabilities: `/api/skills`
- Service probes: Hermes, MILA and Claude status endpoints
- Workspace label: `/api/onboarding`

The page uses `Promise.allSettled()` so a non-critical integration can fail
without hiding Kanban or host health. If every critical source fails, the page
shows an explicit unavailable state instead of stale or invented values.

Operational Home refreshes every 30 seconds while mounted. It is a navigation
and triage surface: mutations remain in Kanban, Routines, Skill Studio,
Integrations and Observability, where their normal role and confirmation rules
apply.
