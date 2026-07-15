# AgentOS Product Strategy and Competitive Roadmap

Status: active
Updated: 2026-07-14

## Decision

AgentOS should be developed as a local-first AI operating layer, not restarted from
the `iceblade1444-art/agentic-os` repository.

Use this workspace as the runtime core:

- `agentosctl.py` for command-line control and release checks.
- `dashboard/backend/app.py` for the local API, approvals, voice, queue, memory,
  worker, runtime traces, and dashboard data.
- `dashboard/frontend/index.html` for the current Mission Control / Mila UI.
- `agents/`, `memory/`, `workflow/`, `approvals/`, `projects/`, `artifacts/`,
  and `logs/` as the local operating state.

Use `iceblade1444-art/agentic-os` as a design and product reference:

- cleaner frontend structure;
- deployable Node/Express style;
- MCP and integration UI ideas;
- product-grade routing, pages, and dashboard information architecture.

Do not copy it wholesale. Its web app is cleaner, but this AgentOS workspace has
the stronger runtime foundation and test coverage.

## Current Local Reality

Verified on 2026-07-14:

- `python agentosctl.py release check --pretty` reports `ready_local`.
- Full test suite passes: `402 passed`.
- Dashboard runs at `http://127.0.0.1:8765/`.
- Mila / Gemini Live readiness is configured locally.
- Voice-agent status now falls back to the built-in AgentOS implementation when
  older external NOVA reference paths are not present on this machine.

The working product is real, but still early. The largest risks are:

- backend and frontend are large single files;
- many runtime logs and generated artifacts live in the repo tree;
- no polished onboarding flow for a new user;
- no production auth / account model for exposing outside localhost;
- UI is visually ambitious but not yet cleanly modular;
- worker execution is intentionally dry-run / guarded, so the product is safer
  than it is autonomous.

## Product Positioning

The strongest product angle is:

> A local-first voice command center for running AI agents against your own
> workspace, with memory, approvals, traces, and project artifacts built in.

This is different from generic agent builders. The promise is not "build any AI
workflow on a canvas." The promise is:

- speak or type one goal;
- AgentOS turns it into a plan;
- risky actions stop at approval;
- work becomes local projects, files, reports, memory, and traces;
- Mila is the single visible assistant, while specialist agents stay behind the
  scenes.

That niche can be competitive if we keep the product opinionated.

## Competitive Analysis

### OpenAI Agents / Responses / Codex

OpenAI's current agent stack emphasizes tool use, MCP, built-in tracing,
guardrails, handoffs, sessions, and resumable approval flows. The official docs
separate direct Responses API control from the Agents SDK, where the SDK manages
the agent loop and handoffs.

What this teaches AgentOS:

- keep our own approval and state model;
- treat MCP as a first-class tool surface;
- add clear traces for every model call, tool call, approval, and handoff;
- keep voice workflows close to the runtime, not as a decorative UI.

Source:

- https://developers.openai.com/api/docs/guides/agents
- https://developers.openai.com/api/docs/guides/tools

### LangSmith Deployment / LangGraph

LangSmith Deployment focuses on durable execution, real-time streaming,
horizontal scaling, and moving from local development to deployed agent
workloads. It can deploy multiple agent frameworks, not only LangGraph.

What this teaches AgentOS:

- durability and streaming are core product features, not extras;
- we need a clean run lifecycle: queued, running, waiting_for_approval, failed,
  completed;
- local-first is fine, but the runtime must be structured enough to later deploy.

Source:

- https://docs.langchain.com/langsmith/deployment

### Dify

Dify positions itself as a production-ready agentic workflow platform with a
visual builder, RAG / knowledge pipelines, model and tool support, and deployment
to cloud, VPC, or self-hosted environments.

What this teaches AgentOS:

- we cannot beat Dify as a general low-code platform quickly;
- we can beat it for personal/local command-center use if setup is simpler and
  the workflow is more human: ask -> approve -> build -> report;
- our memory and local project artifacts should be more concrete than generic
  RAG blocks.

Source:

- https://dify.ai/

### n8n AI Agents

n8n is strong at workflow automation and integrations. Its AI Agent node uses
tools and APIs, and requires at least one tool sub-node. n8n wins through its
huge integration surface and visual workflow familiarity.

What this teaches AgentOS:

- do not compete integration-for-integration;
- expose AgentOS actions as stable tools;
- add import/export bridges later, so AgentOS can call n8n or be called by n8n;
- keep our approval gates clearer than normal automation tools.

Source:

- https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/

### CrewAI

CrewAI combines visual building, code-first APIs, role-based agents,
deterministic workflows, observability, RBAC, audit, human approvals, and policy
hooks. Its enterprise message is "control plane."

What this teaches AgentOS:

- our approval queue, event log, tool registry, and runtime traces are the right
  direction;
- we need to make them easier to see and explain in the UI;
- every agent action should answer: who decided, what tool ran, what data was
  touched, what approval was needed.

Source:

- https://crewai.com/

### Microsoft Agent Framework / AutoGen Studio

Microsoft is moving toward typed agents, state management, middleware,
telemetry, MCP clients, and graph-based workflows with checkpoints and
human-in-the-loop support. AutoGen Studio is explicitly described as a prototype
interface, not production-ready.

What this teaches AgentOS:

- visual agent studios are useful, but the product must not depend on a demo UI;
- our durable state and approvals matter more than flashy multi-agent diagrams;
- checkpoints and human-in-the-loop states should become first-class concepts.

Sources:

- https://learn.microsoft.com/en-us/agent-framework/overview/
- https://microsoft.github.io/autogen/dev/user-guide/autogenstudio-user-guide/index.html

### Relevance AI

Relevance AI sells the "AI workforce" idea: low/no-code agents, multi-agent
teams, knowledge, tools, marketplace, guardrails, and approval workflows.

What this teaches AgentOS:

- "AI employees" is a crowded message;
- AgentOS should avoid generic workforce language and focus on the local operator
  experience;
- templates can help later, but the first product should feel like a personal
  operating room, not an app marketplace.

Source:

- https://relevanceai.com/docs/get-started/introduction

### Devin / AI Software Engineer Tools

Devin is aimed at engineering teams: parallel tasks, tickets, features, bug
fixes, tests, migrations, documentation, and codebase Q&A.

What this teaches AgentOS:

- coding autonomy is a separate market with strong incumbents;
- AgentOS should not promise "fully autonomous engineer" first;
- instead, AgentOS can manage local goals and delegate coding tasks while
  keeping artifacts, approvals, and memory visible.

Source:

- https://docs.devin.ai/get-started/devin-intro

## Competitiveness Verdict

AgentOS is not yet competitive as a general SaaS agent platform against Dify,
n8n, CrewAI, LangSmith, or Relevance AI.

AgentOS can become competitive in a narrower and more defensible category:

- local-first personal / small-team agent command center;
- voice-first Mila assistant;
- safe execution through approvals;
- durable memory and project artifacts;
- transparent run history and traces;
- no-secret frontend and local `.env` discipline;
- ability to later bridge into MCP, n8n, Hermes, Codex, or other agent systems.

The winning strategy is focus. The product should feel like:

> "My local AI operations room."

Not:

> "Another no-code agent builder."

## Architecture We Should Build Toward

```text
Mila UI
  voice, chat, command center, projects, approvals, traces

Frontend adapter layer
  stable API client, route modules, state renderer

AgentOS API
  dashboard/backend/app.py now, later split into modules

Runtime contracts
  goals, projects, tasks, agents, queue, approvals, runs, traces, memory

Execution layer
  dry-run worker first, approved real actions later

Tool layer
  local tools, MCP tools, external integrations, voice provider tools

Storage
  JSON state today; later SQLite for durable multi-table state
```

## Development Phases

### Phase 0: Stabilize What Exists

Goal: no silent breakage before visual work.

Do:

- keep `python agentosctl.py release check --pretty` green;
- keep `pytest -q` green;
- document every new endpoint;
- avoid deleting old runtime state without an explicit cleanup plan.

Definition of done:

- full tests pass;
- dashboard opens on `http://127.0.0.1:8765/`;
- release check returns `ready_local`.

### Phase 1: Freeze API Contracts

Goal: make frontend replacement safe.

Add or document stable endpoints for:

- `/api/mila/status`
- `/api/mila/voice-agent`
- `/api/mila/agent-dock`
- `/api/mila/memory-galaxy`
- `/api/mila/kanban-studio`
- `/api/mila/model-hub`
- `/api/production-readiness`
- approvals, projects, queue runs, events, traces

Where to work:

- backend: `dashboard/backend/app.py`
- tests: `tests/test_*api*.py`, `tests/test_mila_*.py`
- SOP docs: `sops/control-plane-contract.md`

Definition of done:

- each UI panel consumes a documented API response;
- tests assert no raw secrets appear in JSON.

### Phase 2: Modularize The Frontend

Goal: move from one huge HTML file to a maintainable UI.

Target structure:

```text
dashboard/frontend/
  index.html
  assets/
    css/
      tokens.css
      layout.css
      components.css
    js/
      app.js
      api.js
      routes/
        overview.js
        voice.js
        agents.js
        memory.js
        builder.js
        kanban.js
        models.js
        runtime.js
        projects.js
```

Use `iceblade1444-art/agentic-os` as a reference for this split, but keep the
AgentOS visual identity and API contracts.

Where to work:

- current UI: `dashboard/frontend/index.html`
- reference UI ideas: temporary clone of `iceblade1444-art/agentic-os`
- tests: `tests/test_dashboard_frontend.py`, `tests/test_mila_*.py`

Definition of done:

- the same dashboard loads;
- route names stay stable;
- no feature disappears;
- frontend tests still pass.

### Phase 3: Make Mila The Main Product

Goal: one visible assistant, many hidden capabilities.

Build:

- a clean live chat and voice surface;
- status strip: model, voice, memory, approvals, runtime mode;
- command suggestions;
- transcript and memory writeback;
- safe local actions: digest, create project, create task, summarize state;
- clear "needs approval" states.

Where to work:

- voice config: `config/voice.json`, `config/mila.json`
- voice provider: `voice/providers/gemini_live.py`
- backend: Mila endpoints in `dashboard/backend/app.py`
- memory: `memory/mila-initial-memory.md`, `memory/mila-learnings.md`

Definition of done:

- user can type or speak a request;
- Mila either answers, performs a safe local action, or creates an approval;
- every turn is visible in logs or memory as appropriate.

### Phase 4: Runtime And Tool Control Plane

Goal: make AgentOS trustworthy.

Build:

- run detail pages;
- trace viewer;
- approval queue with approve/reject reasoning;
- tool registry UI;
- policy display per tool;
- event log filters;
- dry-run versus execute mode indicator.

Where to work:

- policy: `config/tool-registry.json`, `sops/agent-least-privilege-policy.md`
- traces: `artifacts/agent-worker/runtime-traces/`
- logs: `logs/events.json`, `logs/agent-queue/runs.json`
- tests: `tests/test_agent_worker_*`, `tests/test_event_log_api.py`

Definition of done:

- user can explain what happened in any run;
- risky actions cannot happen invisibly;
- UI never displays raw keys.

### Phase 5: Product Packaging

Goal: make it usable beyond the developer who built it.

Build:

- first-run setup page;
- `.env` check without exposing secrets;
- backup/export/import;
- clean local data directory option;
- tray launcher hardening;
- optional auth if exposed outside localhost;
- deployment notes for Windows-first local use.

Where to work:

- launchers: `scripts/start_mila.bat`, `scripts/start_dashboard.bat`
- installers: `installers/`
- readiness: `agentosctl.py release check`
- docs: `README.md`, `DEPLOY.md` if added later

Definition of done:

- a fresh machine can run it from documented steps;
- secrets stay out of frontend, reports, and git;
- user can recover from a broken local state.

## What To Do After Each Change

Run these checks:

```bat
python C:\Users\User\AgentOS\agentosctl.py release check --pretty
pytest -q
C:\Users\User\AgentOS\scripts\start_dashboard.bat
```

Open:

```text
http://127.0.0.1:8765/
```

If a UI change was made, verify:

- Overview opens.
- Voice / Mila opens.
- Agents dock loads.
- Memory galaxy loads.
- Kanban studio loads.
- Model hub loads.
- Runtime / approvals panel loads.

If a backend change was made, add or update a test first. The project already has
good tests; keep that advantage.

## Where To Work

Use this map when you want to improve something:

| Goal | Main Files |
|---|---|
| Change Mila voice behavior | `config/mila.json`, `config/voice.json`, `voice/providers/gemini_live.py`, `dashboard/backend/app.py` |
| Change visible dashboard UI | `dashboard/frontend/index.html` now; later `dashboard/frontend/assets/*` |
| Add a safe API panel | `dashboard/backend/app.py`, then a matching `tests/test_*api*.py` |
| Add an agent role | `agents/*.md`, `agents/registry.json`, `tests/test_agent_registry.py` |
| Change permissions / risk rules | `config/tool-registry.json`, `sops/agent-least-privilege-policy.md` |
| Add project workflow behavior | `workflow/agentic_workflow.json`, `workflows/*.md`, `agentosctl.py` |
| Update memory | `memory/*.md`, `memory/index.json` |
| Debug what happened | `logs/events.json`, `logs/agent-queue/runs.json`, `artifacts/agent-worker/runtime-traces/` |
| Update strategy or operating rules | `sops/*.md` |

## Immediate Next Build Tasks

1. Cleanly document the current API response contracts in
   `sops/control-plane-contract.md`.
2. Split the frontend into `assets/css` and `assets/js` without changing
   behavior.
3. Add a first-run dashboard card that explains readiness, `.env`, voice, and
   safe/dry-run mode.
4. Build a run-detail page: one queue run -> inputs, tool calls, approvals,
   outputs, artifacts, tests.
5. Add MCP bridge planning: local tools first, remote MCP only after auth and
   approval rules are clear.

## Product Rule

Every new feature must answer four questions:

1. What can the user ask Mila to do?
2. What local state changes?
3. What approval is required before risk?
4. Where can the user see the result later?

If a feature cannot answer those, it belongs in a prototype branch, not the main
product.
