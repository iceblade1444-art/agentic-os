# Hermes Primary Orchestrator

## What Runs Where

```text
User voice/text
  -> Mila + Gemini Live (conversation and speech)
  -> Hermes `default` profile (planning and routing)
  -> AgentOS validator (schema, paths, risk, task cap)
  -> projects/<slug>/tasks.json + agents/queue.json
  -> AgentOS local workers
  -> approval gate for risky actions
  -> Mila speaks the verified result
```

Hermes is strategic. AgentOS remains the execution and safety control plane. Mila is not an orchestrator and Gemini does not execute project actions.

## Configuration

The repository-owned settings are in `config/orchestrator.json`:

- `primary`: must remain `hermes` for this architecture.
- `profile`: Hermes profile name, currently `default`.
- `provider` and `model`: descriptive runtime metadata shown in the dashboard.
- `planning.max_turns`: bounded Hermes planning turns, currently `1`.
- `planning.max_tasks`: maximum validated cards, hard-capped at `24`.
- `planning.tools_allowed`: forced to `false` by the backend.
- `fallback`: safe behavior when Hermes is unavailable.

Hermes authentication stays in the deploy user's `~/.hermes` directory. Never put provider tokens in this repository, dashboard HTML, logs, memory notes, or project artifacts.

## How A Goal Runs

1. `POST /api/orchestrator/create-and-run` receives a goal.
2. AgentOS invokes `hermes chat` in quiet, one-turn, JSON-only planning mode.
3. AgentOS parses the first valid JSON object and validates every task.
4. Absolute paths and `..` artifact paths are removed.
5. Deploy, publish, send, delete, payment, credential, release, and production tasks are forced behind a high-risk human gate.
6. The validated plan is written to `projects/<slug>/` and synchronized to `agents/queue.json`.
7. The local scheduler executes ready cards until completion or an approval gate.

The production command is intentionally planning-only:

```bash
hermes chat -q '<JSON planning prompt>' -Q --source tool --max-turns 1 -t todo
```

Do not replace this with `hermes -z`: one-shot autonomous mode bypasses Hermes approvals and would weaken the AgentOS safety boundary.

## Operator Checks

```bash
curl -fsS http://127.0.0.1:8765/api/orchestrator/status
curl -fsS http://127.0.0.1:8765/api/mila/status
curl -fsS http://127.0.0.1:8765/api/orchestrator
```

A healthy setup reports Hermes as `primary: true`, `ready: true`, profile `default`, and Mila as `voice_assistant` with orchestrator `hermes`.

## Safe Tuning

- Change model/profile metadata in `config/orchestrator.json` only after changing and testing the real Hermes profile.
- Keep `max_turns` low and `tools_allowed` false for plan generation.
- Add new risky-action keywords in `normalize_hermes_plan()` and tests before exposing a new external connector.
- Extend task schemas through structured JSON fields and tests, not prompt-only conventions.
- Keep the public Node Mission route pointed at `AGENTOS_RUNTIME_URL`; otherwise the GitHub visual and runtime will disagree about which orchestrator is active.

## Fallback And Recovery

When Hermes is missing, disabled, times out, exits non-zero, or returns invalid JSON, the project metadata records `plan_source: agentos_safe_plan`. Fix Hermes, verify `/api/orchestrator/status`, then create a new goal. Existing projects remain auditable and are never silently rewritten.
