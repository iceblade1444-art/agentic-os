# Agentic OS — Dashboard

**The operating system for AI agents.** A fully-functional, dependency-free web dashboard to
build, run and orchestrate intelligent agents — agents, chat, a visual workflow builder,
knowledge/memory, MCP servers, integrations, evaluations, observability, guardrails and secrets.

It runs in **two modes**:

- **Static** — the frontend is a dependency-free SPA (HTML + CSS + vanilla ES-module JS). Upload
  the folder to any static host and it works; MCP / Integrations run as an interactive demo.
- **Full** — add the included **Node/Express backend** and MCP, Integrations and the LLM chat
  become **real**: it spawns MCP servers over stdio, validates integration credentials against
  live provider APIs, and proxies streaming LLM calls with server-held keys. The frontend
  auto-detects the backend (topbar shows a green **Live** badge) and falls back to the demo when
  it's absent.

---

## ✨ Features

- **16 pages / routes** — Home dashboard, **Missions**, Agents (full CRUD), Chat, Workflow Builder,
  Tools, Knowledge, Memory, MCP Servers, Integrations, Evaluations, Observability, Guardrails,
  Secrets, Settings, plus a Component Library showcase.
- **Missions & orchestration** — submit a natural-language mission and watch an OpenAI-driven
  orchestrator (or external **Hermes**) execute it with real MCP tools, streaming every step to a
  live feed.
- **Real interactivity** — create/edit/delete agents, drag-and-connect workflow nodes,
  filter/search tables, modals, drawers, dropdowns, toasts, tabs.
- **⌘K command palette** — fuzzy search across pages, agents and quick actions with full
  keyboard navigation (↑/↓/↵/esc).
- **Welcome hero** with an animated gradient orb, **notifications panel**, and **interactive
  chart tooltips** (hover any data point).
- **Accessible** — honours `prefers-reduced-motion`, visible keyboard focus, semantic design
  tokens with contrast checked in both light and dark.
- **Working chat** with streaming — connects to any **OpenAI-compatible** or **Anthropic**
  endpoint (configured in Settings → Model). Falls back to a local demo stream with no key.
- **Dark & light themes** with a full design-token system (Inter, violet/indigo accent,
  8px grid) taken from the reference UI kit.
- **Persistent** — all data (agents, workflows, chats, settings) is saved to the browser's
  `localStorage`. Export a JSON backup or reset to the seeded demo from Settings → Data.
- **Hand-rolled SVG charts** (line/area, donut, sparkline, progress ring) — zero chart libs.
- **Responsive** down to mobile with a collapsible sidebar.

---

## 🚀 Deploy (upload to your server)

It's a static site, so **just copy this whole folder to your web root.** Examples:

```bash
# Nginx / Apache / any static host — copy everything:
scp -r ./* user@yourserver:/var/www/agentic-os/

# GitHub Pages / Netlify / Vercel / Cloudflare Pages:
#   set the project/publish directory to this folder (no build command needed)
```

Then open `https://yourdomain/` (it serves `index.html`).

> **Must be served over HTTP(S)**, not opened as a `file://` path — ES modules require it.
> Any static file server works; there is no backend to run.

### Work from another computer

Keep the source code in a **private Git repository** and treat the server as the
production runtime, not as the only copy of the project. On a new computer:

```bash
git clone <private-repository-url> agentic-os
cd agentic-os
cp .env.example .env
npm ci
```

The real `.env`, production database (`data/`), logs and `node_modules/` are
intentionally excluded from Git. Copy required development secrets separately;
never commit them. Normal updates are: edit and test on a computer, commit and
push, then pull and redeploy on the server.

### Run locally

```bash
# Python 3
python -m http.server 8756
#   → http://127.0.0.1:8756

# or Node
npx serve .
```

---

## 🖥️ Run with the backend (real MCP, integrations & LLM)

The repo ships a Node/Express server (`server/`) that turns the demo features into real ones.

```bash
npm install                 # express, cors, @modelcontextprotocol/sdk
cp .env.example .env        # then edit .env (every key is optional)
npm start                   # → http://localhost:8787  (serves the SPA *and* the API)
```

Open the app — the topbar shows **Live** once the backend is detected. Now:

- **MCP Servers** — *Start* spawns a real MCP server process over stdio, discovers its tools, and
  *Tools* lets you call them. A bundled **`sample-tools`** server (echo / add / server-time /
  agent-facts) works offline with zero downloads. Add your own, e.g.
  `npx -y @modelcontextprotocol/server-filesystem .` or the GitHub server.
- **Integrations** — *Connect* validates credentials against the **live provider API**
  (OpenAI, Anthropic, GitHub, Notion; Slack via webhook). Secrets are stored server-side and
  masked in responses.
- **Chat** — streams through the server LLM proxy using keys from `.env`, so there's no browser
  CORS problem. Leave the in-app key blank to use the server's keys.

### API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Backend probe (auto-detect) |
| POST | `/api/llm/chat/completions` | OpenAI-compatible streaming proxy (OpenAI / Anthropic) |
| GET | `/api/mcp/servers` | List MCP servers |
| POST | `/api/mcp/servers/:id/connect` · `/disconnect` | Spawn / stop a server |
| POST | `/api/mcp/servers/:id/call` | Call a tool `{ tool, args }` |
| GET | `/api/integrations` | List providers + connection state |
| POST | `/api/integrations/:provider/connect` · `/test` · `/disconnect` | Manage a connection |

### Environment

Copy `.env.example` → `.env`. Keys: `PORT`, `HOST_PORT`, `BIND_ADDRESS`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`DEFAULT_MODEL`, `GITHUB_TOKEN`, `NOTION_TOKEN`, `SLACK_WEBHOOK_URL`, `DATA_DIR`, `ALLOW_ORIGIN`.
Anything blank can be set later in the UI (persisted to `DATA_DIR/db.json`, git-ignored).

### Deploy the full app

**PM2 (bare Node host)**
```bash
npm ci --omit=dev
pm2 start server/index.js --name agentic-os --update-env
pm2 save
```

**Docker**
```bash
cp .env.example .env
# Configure AUTH_TOKEN and SECURE_COOKIE before exposing the app.
docker compose up -d --build
```

Keep `BIND_ADDRESS=127.0.0.1` when nginx is on the same host. If a separate
reverse proxy connects over a private network, set `BIND_ADDRESS` to the
server's private IP and restrict that port to the proxy at the firewall.

**Behind Nginx (TLS + reverse proxy)** — disable buffering so chat tokens stream:
```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
}
```

> **Windows note:** the bundled `sample-tools` server spawns `node` and works everywhere.
> `npx`-based MCP servers spawn best on macOS/Linux; on Windows they may need a shell wrapper.

---

## 🚀 Missions & orchestration (Hermes)

**Missions** are natural-language goals that an orchestrator turns into real actions using
Agentic OS's tools. Create one on the **Missions** page (or `POST /api/missions`); a live event
feed shows every step. Two orchestrators are supported:

- **Built-in (OpenAI brain)** — an in-app tool-calling loop (`server/lib/orchestrator.js`). It
  discovers the tools of every connected MCP server and calls them to accomplish the mission,
  streaming steps to the feed. Set `OPENAI_API_KEY` for full autonomy; without a key it runs a
  scripted demo that still executes real tools.
- **Hermes (external agent)** — [Hermes](https://hermes-agent.nousresearch.com/) by Nous Research,
  configured with an OpenAI brain, connects to Agentic OS **over MCP**, pulls missions, executes
  them, and reports progress back into the dashboard feed.

### The bridge: Agentic OS as an MCP server

`server/mcp/agentic-os-server.js` exposes Agentic OS itself as MCP tools:

| Tool | Does |
|---|---|
| `agentic_list_tools` | List tools across all connected MCP servers |
| `agentic_call_tool` | Call a tool on a connected server (auto-connects it) |
| `agentic_list_integrations` | List integration connections |
| `agentic_send_slack` | Send a Slack message via the integration |
| `agentic_run_llm` | Run a one-shot sub-LLM completion |
| `list_missions` / `get_mission` | Pull missions to work on |
| `mission_report` / `mission_complete` | Narrate progress / finish (shows in the dashboard) |

You can also add it to Agentic OS's own MCP page as the **`agentic-os-hub`** server to inspect it.

### Wire up Hermes (OpenAI brain → Agentic OS)

1. **Install Hermes** — see its [installation docs](https://hermes-agent.nousresearch.com/docs/getting-started/installation).
2. **Use OpenAI as the brain** — `~/.hermes/config.yaml`:
   ```yaml
   model:
     provider: openai
     default: gpt-4o
   ```
   Put the key in `~/.hermes/.env`: `OPENAI_API_KEY=sk-...` (or run `hermes model`).
3. **Register Agentic OS as an MCP server** — in `~/.hermes/config.yaml` (make sure Agentic OS is
   running with `npm start` first):
   ```yaml
   mcp_servers:
     agentic-os:
       command: "node"
       args: ["/ABSOLUTE/PATH/TO/Agentic OS/server/mcp/agentic-os-server.js"]
       env:
         AGENTIC_OS_URL: "http://localhost:8787"
   ```
   Then reload/test: `hermes mcp test agentic-os` (or `/reload-mcp` in a session).
4. **Give Hermes a mission.** Either tell Hermes directly, or create a mission in the dashboard
   (Orchestrator → *Hermes*) and have Hermes `list_missions`, act via `agentic_call_tool`, and
   `mission_report` — the **Missions feed updates live**.

> The `agentic-os` MCP server is a thin stdio bridge over the REST API, so Hermes can run on the
> same box or anywhere that can reach `AGENTIC_OS_URL`.

---

## 🔌 Connect a live LLM (Chat)

### MILA Voice integration

Agentic OS can manage the separate MILA voice backend from **Integrations →
MILA Voice**. Configure its internal URL (for example
`http://172.16.10.6:8791`) and server-side `ADMIN_TOKEN`. Once connected, the
dashboard can check Gemini Live readiness and create a 10-minute, one-time code
for the mobile app. The same operations are exposed to missions and Hermes as
`agentic_mila_status` and `agentic_mila_connection_code` tools.

The production mobile endpoint is served under
`https://agent.milanapremium.uz/mila/`; nginx strips the `/mila/` prefix before
forwarding to the isolated Mila container. Long-lived Gemini credentials remain
only in Mila's `.env` and are never returned to Agentic OS or the phone.

1. Open **Settings → Model**.
2. Pick a provider and fill in **Base URL**, **API Key**, **Model**:
   - **OpenAI**: `https://api.openai.com/v1` · e.g. `gpt-4o-mini`
   - **Anthropic**: `https://api.anthropic.com/v1` · e.g. `claude-haiku-4-5-20251001`
   - **OpenAI-compatible** (LM Studio, Ollama, vLLM, your own proxy): `http://localhost:1234/v1`
3. **Save connection** → the Chat page now streams live responses.

The key is stored **only in your browser** (`localStorage`), never sent anywhere but the
endpoint you configure.

> ⚠️ **CORS / production note:** browsers block direct calls to some providers (e.g. OpenAI)
> for security. For production, point **Base URL** at **your own backend proxy** that adds the
> `Authorization` header server-side and forwards to the provider. The UI speaks the standard
> `/chat/completions` (SSE streaming) and Anthropic `/messages` shapes, so a thin proxy is
> enough. Without a reachable endpoint, Chat runs in demo mode so the UI always works.

---

## 🗂️ Project structure

```
index.html                 App shell + font/CSS/JS includes
assets/
  css/
    tokens.css             Design tokens (colors, type, spacing, radius, shadow) — light+dark
    styles.css             Layout + all component styles
  js/
    app.js                 Shell (sidebar/topbar), hash router, theme, bootstrap
    store.js               Reactive localStorage store + seed data
    ui.js                  Helpers: toasts, modals, drawers, menus, SVG charts
    icons.js               Inline SVG icon set (lucide-style)
    api.js                 Backend API client + auto-detection (falls back to demo)
    pages/
      dashboard.js         Home: stats, charts, activity, health, top agents
      agents.js            Agents table + create/edit modal + detail drawer + delete
      missions.js          Missions: submit a goal + live orchestration event feed
      chat.js              Streaming chat (backend proxy / direct / demo fallback)
      workflows.js         Drag-and-connect SVG node canvas
      settings.js          Appearance / Model / Profile / Data
      components.js        Component library showcase (all UI primitives + tokens)
      misc.js              Tools, Knowledge, Memory, MCP, Integrations,
                           Observability, Guardrails, Secrets, Evaluations
server/                    Node/Express backend (optional — enables the real features)
  index.js                 Express app: serves the SPA + /api, graceful shutdown
  config.js                Env config (reads .env)
  store.js                 JSON datastore (DATA_DIR/db.json)
  routes/llm.js            OpenAI-compatible streaming proxy + /complete (OpenAI / Anthropic)
  routes/mcp.js            MCP CRUD + connect / disconnect / call
  routes/integrations.js   Connection CRUD + real credential tests
  routes/missions.js       Missions CRUD + event feed + run (built-in orchestrator, SSE)
  mcp/manager.js           Spawns MCP servers over stdio (SDK client), lists/calls tools
  mcp/sample-server.js     Bundled demo MCP server (echo / add / time / facts)
  mcp/agentic-os-server.js MCP bridge: exposes Agentic OS as tools for Hermes/orchestrators
  mcp/obsidian-server.js   MCP server: read/search/write notes in an Obsidian vault
  lib/connectors.js        Real provider checks (OpenAI / Anthropic / GitHub / Notion / Slack)
  lib/orchestrator.js      Built-in OpenAI tool-calling mission loop (Hermes-style)
Dockerfile · .env.example · package.json
```

---

## 🎨 Customize

- **Brand colors / theme:** edit `assets/css/tokens.css` (`--violet-*`, `--primary`,
  neutral scale, both `[data-theme]` blocks).
- **Seed data:** edit the `seed()` function in `assets/js/store.js`.
- **Navigation:** edit the `NAV` array in `assets/js/app.js`.
- **Add a page:** drop a module in `assets/js/pages/` exporting
  `{ title, render(ctx), mount(root, ctx) }`, then register it in `PAGES` in `app.js`.

---

## 🔒 Notes

- Fonts (Inter, JetBrains Mono) load from Google Fonts; the UI falls back to system fonts if
  offline. To self-host, download the fonts and swap the `<link>` in `index.html`.
- **What's real with the backend running:** MCP tool discovery & calls, integration credential
  checks, and streaming LLM chat. **Still client-side (`localStorage`):** agents, workflows and
  chat history — they need no server. Add auth and move them into `server/store.js` for
  multi-user / multi-device persistence.
- Integration secrets and LLM keys live **server-side** (`.env` and `DATA_DIR/db.json`, both
  git-ignored). The server static-serves only `assets/` + `index.html` — never `.env` or `server/`.
- **Auth & hardening:** set `AUTH_TOKEN` to require login on `/api/*` (browser session cookie or a
  `Bearer` token for API clients). The app also ships security headers + CSP, per-IP rate limiting,
  and gates arbitrary-command MCP spawning behind `ALLOW_CUSTOM_MCP` (off by default). Without
  `AUTH_TOKEN` the API is open — keep it on localhost/LAN in that case. See [DEPLOY.md](DEPLOY.md).

## 🙏 Design credits

The visual system was refined using design intelligence from the **ui-ux-pro-max** skill
(dark-OLED palette strategy, elevation, glow/motion timing, accessibility rules) and brand-system
patterns from the **open-design** skill library — layered on top of the reference UI-kit mockups
that defined the Inter + violet identity, 8px grid, and component set.

---

MIT-style: use it, change it, ship it.
