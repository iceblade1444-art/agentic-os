# AgentOS

Local-first Agentic OS workspace built on top of Hermes Agent.

## Goal

Create a practical AI operating layer where a user can give one goal and the system can:

1. Plan work through an Orchestrator.
2. Break work into task cards / task graph.
3. Assign tasks to specialist agents.
4. Store durable business memory and SOPs.
5. Produce artifacts in `projects/` and `artifacts/`.
6. Log decisions, blockers, approvals, and final results.
7. Keep risky actions behind explicit approval gates.

## Main folders

```text
AgentOS/
  agents/       Agent role specifications and prompts
  workflows/    Repeatable orchestration workflows
  memory/       Durable user/business/project memory
  sops/         Standard operating procedures
  projects/     Active project workspaces
  drafts/       Draft outputs, especially emails/content awaiting approval
  approvals/    Approval queue for risky actions
  logs/         Daily logs and run reports
  artifacts/    Generated files, reports, exports
  dashboard/    Future Mission Control UI
```

## First verified demo

The first end-to-end scenario is:

> Create a simple landing page for an AI SEO agency, save it locally, verify the HTML, and produce a run report.

See:

- `projects/ai-seo-landing-page/`
- `logs/daily/`

## Release quickstart

Run the local readiness check:

```bash
python C:/Users/User/AgentOS/agentosctl.py release check --pretty
```

Start the Mission Control dashboard:

```bash
bash C:/Users/User/AgentOS/scripts/start_dashboard.sh
```

or on Windows:

```bat
C:\Users\User\AgentOS\scripts\start_dashboard.bat
```

Open:

```text
http://127.0.0.1:8765/
```

Prepare a local-file voice sample:

```bash
python C:/Users/User/AgentOS/agentosctl.py voice sample --text "покажи digest"
```

Run a bounded local-file voice loop:

```bash
python C:/Users/User/AgentOS/agentosctl.py voice loop --provider local_file --cycles 3 --interval 1
```

or use:

```bash
bash C:/Users/User/AgentOS/scripts/start_voice_loop.sh
```

Safety notes:

- real external actions stay behind approval gates;
- real Hermes Kanban creation requires approval;
- Gemini Live remains optional until credentials and realtime transport are configured;
- dashboard voice controls never store API keys.

## Mila desktop quickstart

Mila is the Jarvis-style UX layer for AgentOS. It keeps the same safety model: microphone input and Gemini normalization route through `/api/voice-session`, then through the command bridge and approval gates.

Start Mila on Windows:

```bat
C:\Users\User\AgentOS\scripts\start_mila.bat
```

Start Mila from Git Bash:

```bash
bash C:/Users/User/AgentOS/scripts/start_mila.sh
```

Install Windows autostart after you have confirmed `.env` is configured:

```bat
C:\Users\User\AgentOS\installers\install_mila_autostart.bat
```

Remove Windows autostart:

```bat
C:\Users\User\AgentOS\installers\uninstall_mila_autostart.bat
```

Secrets stay in:

```text
C:\Users\User\AgentOS\.env
```

Do not put API keys into launcher scripts, dashboard HTML, JSON configs, reports, or chat.

## Agentic OS video-inspired interface

The Mila dashboard now follows the visual direction from the Agentic OS reference video `A75zZTFw_o0`:

- **Agentic OS Command Center** shell with left-side module navigation;
- whole team of AI workers / agent dock;
- Obsidian-style memory galaxy;
- app builder flow from idea → plan → approval → build → preview;
- Kanban board studio for multi-agent iteration;
- model/plugin hub for swapping new models without rebuilding the OS;
- preview stage and daily changelog/report habit.

Reference:

```text
https://www.youtube.com/watch?v=A75zZTFw_o0
```

## Product strategy and roadmap

The current product direction is documented here:

```text
sops/product-strategy-and-competitive-roadmap.md
```

Short version: keep this AgentOS workspace as the local/runtime core, and keep
`iceblade1444-art/agentic-os` as the canonical production visual shell. The
full deployed product should live on GitHub and the server as a combined system:
GitHub visual frontend + Node backend + this AgentOS runtime + Hermes + Obsidian.
Before changing major UI, runtime, agent, voice, or approval flows, read that
roadmap first so the project stays understandable and competitive.

Production deployment notes for `agent.milanapremium.uz` are documented here:

```text
sops/production-deploy-agent-milanapremium.md
```

Read that runbook before changing server access, Hermes Agent, Obsidian vault,
systemd, nginx/OpenResty, or production environment variables.

## Mila dashboard routes

Phase 1 of the post-video UI work adds primary dashboard routes so the huge single page can be progressively split into focused workspaces:

```text
#overview  System status, production readiness, digest
#voice     Mila realtime voice, Voice Adapter, Gemini session, transcripts
#agents    Agent dock and worker state
#memory    Memory galaxy and second brain
#builder   App builder idea → plan → approval → build → preview
#kanban    Kanban studio and multi-agent flow
#models    Model/plugin hub
#runtime   Approvals, Event Log, worker daemon, audits, trace/retention
#projects  Projects, tasks, linked Hermes tasks, queue runs
```

## Mila live agent dock

Phase 2 adds a read-only live agent dock backed by AgentOS state:

```text
GET /api/mila/agent-dock
```

The dock maps UI cards to live signals for:

```text
orchestrator      projects, queue items, routing state
coding-agent      queue items, queue runs, TDD state
qa-agent          latest report and full-suite expectations
research-agent    video/docs/transcript research state
approval-guard    pending approvals and safety gates
voice-agent       /api/voice-session and Gemini Live voice readiness
```

The endpoint is read-only, does not execute actions, and does not include secrets.

## Mila live memory galaxy

Phase 3 adds a read-only live second-brain graph backed by local AgentOS files:

```text
GET /api/mila/memory-galaxy
```

The graph includes nodes for:

```text
projects
reports
events
sops
skills
voice-transcripts
```

The dashboard renders those nodes in the Memory Galaxy with counts and latest report context. The endpoint is read-only and secret-safe.

## Mila functional app builder

Phase 4 adds a safe, dry-run app builder blueprint path:

```text
GET /api/mila/app-builder/blueprint?idea=<idea>
```

The flow is:

```text
idea → plan → approval → build → preview → iterate
```

The blueprint endpoint returns a plan, slug, preview artifact path, and approval metadata. It does not write files and keeps real build/scaffold execution behind approval gates.

## Mila live Kanban Studio

Phase 5 adds a read-only Kanban Studio backed by AgentOS tasks, agent queue items, and queue runs:

```text
GET /api/mila/kanban-studio
```

The lane flow is:

```text
Planned → Building → Judge → Done
```

The endpoint returns lane counts and bounded cards for dashboard display. It is read-only; real task creation/export remains behind existing safe endpoints and approval gates.

## Mila live Model Hub

Phase 6 adds a read-only provider/model catalog backed by the local voice/provider configuration:

```text
GET /api/mila/model-hub
```

The hub renders provider cards for mock, local-file, Gemini Live, and future model/plugin providers. It reports enabled/ready state, mode, model name, and credential state, but raw keys are never returned.

## Mila native tray scaffold

Phase 7 adds a secret-free desktop tray scaffold for opening and supervising the local Mila dashboard:

```text
GET /api/mila/tray-package
scripts/mila_tray.py
scripts/start_mila_tray.bat
```

The scaffold exposes safe local actions only: open dashboard, status, restart dashboard, and quit. It does not embed credentials, does not elevate privileges, and keeps real installer/autostart behavior behind explicit operator actions.

## Mila Jarvis visual polish

Phase 8 adds the final focused command center polish layer:

```text
GET /api/mila/visual-polish
```

The dashboard now includes a compact `milaJarvisWorkspace` section with live signal cards, a safety ribbon, and workspace lanes for Ask → Approve → Build/Preview. This keeps the UI closer to a voice-first Agentic OS/Jarvis workspace while preserving approval gates and no-secret surfaces.
