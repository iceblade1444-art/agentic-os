import { api } from "../api.js";
import { icon } from "../icons.js";
import { store, timeAgo } from "../store.js";
import { esc, toast } from "../ui.js";

const META = {
  default: { label: "Hermes", role: "Orchestrator", icon: "brain", color: "violet" },
  scout: { label: "Scout", role: "Research", icon: "search", color: "blue" },
  scribe: { label: "Scribe", role: "Writing", icon: "edit", color: "cyan" },
  reach: { label: "Reach", role: "Growth", icon: "up", color: "amber" },
  dev: { label: "Dev", role: "Engineering", icon: "code", color: "green" },
};

let dashboardState = null;
let dashboardError = "";
let dashboardLoading = false;
let dashboardPoll = null;

const rerender = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
const value = (result, fallback) => result.status === "fulfilled" ? result.value : fallback;
const tasksFrom = (board = {}) => (board.columns || []).flatMap((column) =>
  (column.tasks || []).map((task) => ({ ...task, status: task.status || column.name })));
const openStatuses = new Set(["triage", "todo", "scheduled", "ready", "running", "blocked", "review"]);

function statusTone(status) {
  if (["healthy", "ready", "active", "done", "completed"].includes(status)) return "success";
  if (["failed", "error", "critical", "blocked"].includes(status)) return "error";
  if (["degraded", "attention", "running", "paused", "review"].includes(status)) return "warning";
  return "neutral";
}

function stat(label, number, detail, ico, href) {
  return `<a class="stat operational-stat" href="${href}">
    <div class="row between"><span class="stat-label">${esc(label)}</span><span class="stat-icon">${icon(ico)}</span></div>
    <div class="stat-value">${esc(number)}</div>
    <div class="hint">${esc(detail)}</div>
  </a>`;
}

function age(value) {
  const timestamp = Number(value);
  if (Number.isFinite(timestamp)) return timeAgo(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? "Unknown" : timeAgo(parsed);
}

function service(label, ready, detail, href) {
  return `<a class="ops-service" href="${href}">
    <span class="ops-service-icon ${ready ? "ready" : "attention"}">${icon(ready ? "check" : "warn")}</span>
    <span><strong>${esc(label)}</strong><small>${esc(detail)}</small></span>
    <span class="badge ${ready ? "success" : "warning"}">${ready ? "Ready" : "Check"}</span>
  </a>`;
}

function fleetState(profile, tasks) {
  const assigned = tasks.filter((task) => task.assignee === profile.name);
  const running = assigned.filter((task) => task.status === "running").length;
  const blocked = assigned.filter((task) => task.status === "blocked").length;
  const queued = assigned.filter((task) => openStatuses.has(task.status) && task.status !== "running" && task.status !== "blocked").length;
  return {
    running,
    blocked,
    queued,
    label: running ? "Working" : blocked ? "Blocked" : queued ? "Queued" : "Ready",
    tone: running ? "warning" : blocked ? "error" : queued ? "info" : "success",
  };
}

function loadingHTML() {
  return `<div class="grid cols-4 mb-4">${Array.from({ length: 4 }, () => `<div class="stat"><div class="skeleton" style="height:82px"></div></div>`).join("")}</div><div class="card pad-lg"><div class="skeleton" style="height:360px"></div></div>`;
}

function dashboardHTML(data) {
  const tasks = tasksFrom(data.board);
  const open = tasks.filter((task) => openStatuses.has(task.status));
  const running = tasks.filter((task) => task.status === "running");
  const blocked = tasks.filter((task) => task.status === "blocked");
  const routines = Array.isArray(data.routines) ? data.routines : [];
  const activeRoutines = routines.filter((job) => job.enabled !== false && !job.paused && job.status !== "paused");
  const readiness = data.operations.readiness || { score: 0, sections: [], recommendations: [] };
  const backup = data.operations.backup || {};
  const recommendations = readiness.recommendations || [];
  const profiles = data.profiles.profiles || [];
  const usage = data.usage || [];
  const priorityTasks = [...open].sort((a, b) => {
    const rank = (task) => task.status === "blocked" ? 0 : task.status === "running" ? 1 : task.status === "review" ? 2 : 3;
    return rank(a) - rank(b) || Number(b.priority || 0) - Number(a.priority || 0);
  }).slice(0, 8);

  return `
    <div class="page-head operational-head">
      <div><div class="page-title">Operational Home</div><div class="page-sub">Live state for ${esc(data.onboarding.workspace?.name || "Agentic OS")} · updated ${esc(age(data.checkedAt))}</div></div>
      <div class="spacer"></div>
      <button class="btn btn-secondary" id="dashboardRefresh">${icon("refresh")}Refresh</button>
      ${api.auth.canWrite ? `<a class="btn btn-primary" href="#/kanban/new">${icon("plus")}New task</a>` : ""}
    </div>

    <div class="grid cols-4 mb-4">
      ${stat("Four C readiness", `${readiness.score || 0}%`, readiness.status === "ready" ? "Core operating layers are ready" : "Review operational gaps", "observability", "#/observability")}
      ${stat("Open work", open.length, `${running.length} running · ${blocked.length} blocked`, "workflow", "#/kanban")}
      ${stat("Hermes fleet", profiles.length, `${profiles.filter((profile) => fleetState(profile, tasks).running).length} profiles working`, "agents", "#/agents")}
      ${stat("Active routines", activeRoutines.length, `${routines.length} total scheduled jobs`, "calendar", "#/routines")}
    </div>

    ${recommendations.length ? `<div class="ops-action-strip mb-4"><div><span class="badge warning">Next action</span><strong>${esc(recommendations[0].title)}</strong><span>${esc(recommendations[0].detail)}</span></div><a class="btn btn-secondary sm" href="${esc(recommendations[0].href)}">Resolve ${icon("arrowright")}</a></div>` : `<div class="ops-action-strip is-ready mb-4"><div><span class="badge success">Ready</span><strong>No operational gaps detected</strong><span>Context, connections, capabilities and cadence are healthy.</span></div><a class="btn btn-secondary sm" href="#/observability">View audit ${icon("arrowright")}</a></div>`}

    <div class="operational-grid mb-4">
      <section class="card" style="padding:0">
        <div class="card-head ops-card-head"><div><h3>Work queue</h3><p class="hint">Active Hermes Kanban tasks ordered by operational priority</p></div><a class="btn btn-ghost sm" href="#/kanban">Open board ${icon("arrowright")}</a></div>
        ${priorityTasks.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Task</th><th>Status</th><th>Assignee</th><th>Priority</th><th>Created</th></tr></thead><tbody>${priorityTasks.map((task) => `<tr><td><a class="fw-600" href="#/kanban">${esc(task.title || task.id)}</a></td><td><span class="badge ${statusTone(task.status)}">${esc(task.status)}</span></td><td>${esc(task.assignee || "default")}</td><td class="mono">P${Math.max(0, Number(task.priority) || 0)}</td><td class="muted nowrap">${esc(age(task.created_at || task.createdAt))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty ops-empty"><div class="empty-ico">${icon("check")}</div><h4>No open work</h4><p>Create a task or mission to route verified work through the Hermes fleet.</p></div>`}
      </section>

      <section class="card pad-lg">
        <div class="card-head"><div><h3>Core services</h3><p class="hint">Live server-side probes</p></div></div>
        <div class="stack gap-2">
          ${service("Hermes orchestrator", data.hermes.ready, data.hermes.ready ? "Dashboard bridge reachable" : data.hermes.error || "Unavailable", "#/hermes")}
          ${service("MILA voice", data.mila.ok && data.mila.voiceConfigured, data.mila.ok ? (data.mila.liveModel || "Voice configured") : data.mila.error || "Unavailable", "#/mila")}
          ${service("Claude Workspace", data.claude.ready && data.claude.auth?.loggedIn, data.claude.ready ? (data.claude.model?.resolved || data.claude.defaultModel || "Authenticated") : data.claude.error || "Unavailable", "#/claude")}
          ${service("Obsidian vault", data.knowledge.ready && data.knowledge.writable, `${data.knowledge.notes || 0} notes · ${data.knowledge.folders || 0} folders`, "#/knowledge")}
          ${service("Automated backup", backup.status === "success", backup.status === "success" ? `Last success ${age(backup.lastSuccessAt)}` : "No successful backup", "#/observability")}
        </div>
      </section>
    </div>

    <div class="operational-lower-grid">
      <section class="card pad-lg">
        <div class="card-head"><div><h3>Four C</h3><p class="hint">Current product readiness</p></div><span class="badge ${statusTone(readiness.status)}">${esc(readiness.score || 0)}%</span></div>
        <div class="stack gap-3">${(readiness.sections || []).map((section) => `<a class="ops-progress" href="#/observability"><div class="row between"><span>${esc(section.label)}</span><strong>${esc(section.score)}%</strong></div><div class="progress"><span style="width:${Math.max(0, Math.min(100, Number(section.score) || 0))}%"></span></div></a>`).join("")}</div>
      </section>

      <section class="card pad-lg">
        <div class="card-head"><div><h3>Hermes fleet</h3><p class="hint">Persistent specialist profiles</p></div><a class="btn btn-ghost sm" href="#/agents">Manage</a></div>
        <div class="ops-fleet">${profiles.map((profile) => {
          const meta = META[profile.name] || { label: profile.name, role: "Agent", icon: "bot", color: "violet" };
          const current = fleetState(profile, tasks);
          return `<a class="ops-agent" href="#/agents"><span class="kanban-agent-icon ${esc(meta.color)}">${icon(meta.icon)}</span><span><strong>${esc(meta.label)}</strong><small>${esc(meta.role)} · ${current.running || current.queued || current.blocked || 0} active</small></span><span class="badge ${current.tone}">${esc(current.label)}</span></a>`;
        }).join("")}</div>
      </section>

      <section class="card pad-lg">
        <div class="card-head"><div><h3>Knowledge activity</h3><p class="hint">${data.knowledge.notes || 0} Obsidian notes · ${data.skills.length || 0} Hermes skills</p></div><a class="btn btn-ghost sm" href="#/knowledge">Library</a></div>
        ${usage.length ? `<div class="stack gap-2">${usage.slice(0, 6).map((entry) => `<div class="ops-activity"><span>${icon(entry.action === "read" ? "file" : entry.action === "search" ? "search" : "edit")}</span><div><strong>${esc(entry.actor || "Agent")}</strong><small>${esc(entry.action || "used knowledge")}${entry.path ? ` · ${esc(entry.path)}` : ""}</small></div><time>${esc(age(entry.at))}</time></div>`).join("")}</div>` : `<div class="empty ops-empty"><div class="empty-ico">${icon("knowledge")}</div><h4>No recent knowledge activity</h4><p>Agent reads and approved writes will appear here.</p></div>`}
      </section>
    </div>`;
}

async function loadDashboard(force = false) {
  if (dashboardLoading && !force) return;
  dashboardLoading = true;
  const results = await Promise.allSettled([
    api.operations.status(),
    api.kanban.board(),
    api.kanban.profiles(),
    api.routines.list("all"),
    api.knowledge.status(),
    api.knowledge.usage(12),
    api.skills.list("default"),
    api.hermes.status(),
    api.claude.status(false),
    api.integrations.milaStatus(),
    api.onboarding.get(),
  ]);
  const critical = [results[0], results[1], results[2]];
  if (critical.every((result) => result.status === "rejected")) {
    dashboardError = critical[0].reason?.message || "Operational data is unavailable";
    dashboardState = null;
  } else {
    dashboardState = {
      operations: value(results[0], { status: "unknown", readiness: { score: 0, sections: [], recommendations: [] }, backup: {} }),
      board: value(results[1], { columns: [] }),
      profiles: value(results[2], { profiles: [] }),
      routines: value(results[3], []),
      knowledge: value(results[4], {}),
      usage: value(results[5], []),
      skills: value(results[6], []),
      hermes: value(results[7], {}),
      claude: value(results[8], {}),
      mila: value(results[9], {}),
      onboarding: value(results[10], { workspace: {} }),
      checkedAt: Date.now(),
    };
    dashboardError = "";
  }
  dashboardLoading = false;
  rerender();
}

export default {
  title: "Home",
  render() {
    if (!api.on) return `<div class="page-head"><div><div class="page-title">Operational Home</div><div class="page-sub">Start the backend to read live system state</div></div></div><div class="alert warning"><div class="a-body"><div class="a-title">Backend unavailable</div><div class="a-desc">Operational Home does not display demo metrics.</div></div></div>`;
    if (dashboardError) return `<div class="page-head"><div><div class="page-title">Operational Home</div><div class="page-sub">Live Agentic OS state</div></div><div class="spacer"></div><button class="btn btn-secondary" id="dashboardRefresh">${icon("refresh")}Retry</button></div><div class="alert error"><div class="a-body"><div class="a-title">Could not load operational state</div><div class="a-desc">${esc(dashboardError)}</div></div></div>`;
    return dashboardState ? dashboardHTML(dashboardState) : `<div class="page-head"><div><div class="page-title">Operational Home</div><div class="page-sub">Reading live Agentic OS state</div></div></div>${loadingHTML()}`;
  },
  mount(root) {
    root.querySelector("#dashboardRefresh")?.addEventListener("click", async (event) => {
      event.currentTarget.classList.add("loading");
      await loadDashboard(true);
      toast("success", "Operational state refreshed");
    });
    if (!dashboardState && !dashboardLoading) loadDashboard();
    dashboardPoll = setInterval(() => loadDashboard(true), 30000);
  },
  unmount() {
    clearInterval(dashboardPoll);
    dashboardPoll = null;
  },
};
