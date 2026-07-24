import { api } from "../api.js";
import { icon } from "../icons.js";
import { store, timeAgo } from "../store.js";
import { esc, toast } from "../ui.js";

const META = {
  default: { label: "Hermes", role: "Orchestrator", icon: "brain", color: "violet" },
  scout: { label: "Scout", role: "Research", icon: "search", color: "teal" },
  scribe: { label: "Scribe", role: "Writing", icon: "edit", color: "blue" },
  reach: { label: "Reach", role: "Growth", icon: "up", color: "amber" },
  dev: { label: "Dev", role: "Engineering", icon: "code", color: "green" },
};

let dashboardState = null;
let dashboardError = "";
let dashboardLoading = false;
let dashboardPoll = null;
let liveStream = null;
let liveEvents = [];

const rerender = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
const value = (result, fallback) => result.status === "fulfilled" ? result.value : fallback;
const timeoutValue = (fallback, ms = 5000) => new Promise((resolve) => setTimeout(() => resolve(fallback), ms));
const bounded = (promise, fallback, ms = 5000) => Promise.race([promise.catch(() => fallback), timeoutValue(fallback, ms)]);
const tasksFrom = (board = {}) => (board.columns || []).flatMap((column) =>
  (column.tasks || []).map((task) => ({ ...task, status: task.status || column.name })));
const openStatuses = new Set(["triage", "todo", "scheduled", "ready", "running", "blocked", "review"]);
const gb = (bytes) => `${(bytes / (1024 ** 3)).toFixed(bytes >= 100 * 1024 ** 3 ? 0 : 1)} GB`;

function age(value) {
  const timestamp = Number(value);
  if (Number.isFinite(timestamp) && timestamp > 0) return timeAgo(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? "Unknown" : timeAgo(parsed);
}

function statusTone(status) {
  if (["healthy", "ready", "active", "done", "completed"].includes(status)) return "success";
  if (["failed", "error", "critical", "blocked"].includes(status)) return "error";
  if (["degraded", "attention", "running", "paused", "review"].includes(status)) return "warning";
  return "neutral";
}

function fleetState(profile, tasks) {
  const assigned = tasks.filter((task) => task.assignee === profile.name);
  const running = assigned.filter((task) => task.status === "running");
  const waiting = assigned.filter((task) => task.status === "blocked" && task.block_kind === "needs_input");
  const blocked = assigned.filter((task) => task.status === "blocked" && task.block_kind !== "needs_input");
  const queued = assigned.filter((task) => openStatuses.has(task.status) && task.status !== "running" && task.status !== "blocked");
  return {
    running, waiting, blocked, queued,
    label: running.length ? "Working" : blocked.length ? "Blocked" : waiting.length ? "Waiting input" : queued.length ? "Queued" : "Ready",
    tone: running.length || waiting.length ? "warning" : blocked.length ? "error" : queued.length ? "info" : "success",
  };
}

// ---------- sparklines from /api/pulse history ----------

function seriesFrom(history, key, points = 40) {
  const values = (history || []).map((sample) => Number(sample?.[key])).filter(Number.isFinite);
  if (values.length <= points) return values;
  const step = values.length / points;
  return Array.from({ length: points }, (_, i) => values[Math.min(values.length - 1, Math.round(i * step))]);
}

function sparkline(values, { width = 120, height = 30 } = {}) {
  if (!values || values.length < 2) return `<div class="oh-spark-empty">History builds up as the server runs</div>`;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const point = (v, i) => `${(i * step).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 7)).toFixed(1)}`;
  const line = values.map(point).join(" ");
  const [lastX, lastY] = point(values[values.length - 1], values.length - 1).split(",");
  return `<svg class="oh-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="0,${height} ${line} ${width},${height}" fill="var(--primary-soft)"/>
    <polyline points="${line}" fill="none" stroke="var(--primary)" stroke-width="2"/>
    <circle cx="${lastX}" cy="${lastY}" r="2.6" fill="var(--primary)"/>
  </svg>`;
}

function deltaAgainst(history, key, current, hoursBack = 24) {
  const cutoff = Date.now() - hoursBack * 3600 * 1000;
  const past = (history || []).filter((sample) => Number(sample?.t) <= cutoff).pop();
  const previous = Number(past?.[key]);
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return "";
  const diff = current - previous;
  if (!diff) return `<span class="oh-delta flat">no change · 24h</span>`;
  return `<span class="oh-delta ${diff > 0 ? "up" : "down"}">${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)} · 24h</span>`;
}

function kpi(label, valueText, deltaHTML, sparkHTML, href) {
  return `<a class="card oh-kpi" href="${href}">
    <span class="oh-kpi-label">${esc(label)}</span>
    <span class="oh-kpi-value">${esc(valueText)}</span>
    ${deltaHTML || `<span class="oh-delta flat">&nbsp;</span>`}
    ${sparkHTML}
  </a>`;
}

// ---------- pulse strip ----------

function svc(ok, label, detail, href) {
  return `<a class="oh-svc" href="${href}" title="${esc(detail)}">
    <span class="oh-dot ${ok ? "ok" : "warn"}${ok ? "" : " oh-pulse-anim"}"></span>
    <strong>${esc(label)}</strong><small>${esc(detail)}</small>
  </a>`;
}

// ---------- attention ----------

function attentionItems(data) {
  const items = [];
  const admin = api.auth.canAdmin;
  if (data.pulse.approvalsAvailable) {
    for (const approval of data.pulse.approvals.slice(0, 4)) {
      items.push({
        sev: "info",
        title: `Approve: ${approval.summary || approval.action}`,
        detail: `${approval.project ? `${approval.project} · ` : ""}waiting ${approval.requestedAt ? age(approval.requestedAt) : "for review"}`,
        actions: admin
          ? `<button class="btn btn-primary sm" data-approval="${esc(approval.id)}" data-decision="approve">Approve</button>
             <button class="btn btn-secondary sm" data-approval="${esc(approval.id)}" data-decision="deny">Deny</button>`
          : `<a class="btn btn-secondary sm" href="#/missions">Review</a>`,
      });
    }
  } else {
    items.push({ sev: "warn", title: "AgentOS runtime is unreachable", detail: "Approvals and mission events are hidden until it answers", actions: `<a class="btn btn-secondary sm" href="#/observability">Details</a>` });
  }
  const tasks = tasksFrom(data.board);
  for (const task of tasks.filter((t) => t.status === "blocked" && t.block_kind !== "needs_input").slice(0, 3)) {
    items.push({ sev: "err", title: `Task blocked: ${task.title || task.id}`, detail: task.block_reason || `assignee ${task.assignee || "default"}`, actions: `<a class="btn btn-secondary sm" href="#/kanban">Open</a>` });
  }
  for (const task of tasks.filter((t) => t.status === "blocked" && t.block_kind === "needs_input").slice(0, 2)) {
    items.push({ sev: "warn", title: `Waiting for input: ${task.title || task.id}`, detail: `assignee ${task.assignee || "default"}`, actions: `<a class="btn btn-secondary sm" href="#/kanban">Answer</a>` });
  }
  const disk = data.pulse.host?.disk;
  if (disk && disk.usedPct >= 85) {
    items.push({ sev: disk.usedPct >= 93 ? "err" : "warn", title: `Disk usage at ${disk.usedPct}%`, detail: `${gb(disk.freeBytes)} free — prune Docker or expand the volume`, actions: `<a class="btn btn-secondary sm" href="#/observability">Details</a>` });
  }
  const backup = data.operations.backup || {};
  if (backup.status && backup.status !== "success") {
    items.push({ sev: "warn", title: "Automated backup is not green", detail: `Last status: ${backup.status}`, actions: `<a class="btn btn-secondary sm" href="#/observability">Inspect</a>` });
  }
  const drill = data.operations.restoreDrill || {};
  if (drill.status && drill.status !== "success") {
    items.push({ sev: "warn", title: "Backup restore has not been verified", detail: "Run a restore drill so backups are provably usable", actions: `<a class="btn btn-secondary sm" href="#/observability">Run drill</a>` });
  }
  const recommendation = (data.operations.readiness?.recommendations || [])[0];
  if (recommendation) {
    items.push({ sev: "info", title: recommendation.title, detail: recommendation.detail || "", actions: `<a class="btn btn-secondary sm" href="${esc(recommendation.href || "#/observability")}">Resolve</a>` });
  }
  return items;
}

// ---------- activity feed ----------

function feedEntries(data) {
  const entries = [];
  for (const event of data.pulse.events || []) {
    entries.push({ at: event.at, actor: event.actor || "AgentOS", message: event.message || event.type, agent: null });
  }
  for (const entry of data.usage || []) {
    entries.push({
      at: Number(entry.at) || null,
      actor: entry.actor || "Agent",
      message: `${entry.action || "used knowledge"}${entry.path ? ` · ${entry.path}` : ""}`,
      agent: null,
    });
  }
  for (const mission of (data.missions || []).slice(0, 8)) {
    for (const event of (mission.events || []).slice(-3)) {
      entries.push({ at: event.at, actor: "Mission", message: `${mission.title}: ${event.message || event.type}`, agent: null });
    }
  }
  for (const entry of liveEvents) entries.push(entry);
  const seen = new Set();
  return entries
    .filter((entry) => Number.isFinite(Number(entry.at)))
    .filter((entry) => { const key = `${entry.at}|${entry.message}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => b.at - a.at)
    .slice(0, 14);
}

function feedItemHTML(entry, fresh = false) {
  const profile = Object.keys(META).find((name) => (entry.actor || "").toLowerCase() === name || (entry.actor || "").toLowerCase() === META[name].label.toLowerCase());
  const color = profile ? META[profile].color : "";
  const time = new Date(entry.at);
  const stampText = Number.isNaN(time.getTime()) ? "" : time.toTimeString().slice(0, 5);
  return `<div class="oh-feed-item${fresh ? " fresh" : ""}">
    <time class="mono">${esc(stampText)}</time>
    <span class="oh-feed-actor ${esc(color)}">${esc(entry.actor || "System")}</span>
    <span class="oh-feed-msg">${esc(entry.message || "")}</span>
  </div>`;
}

// ---------- fleet lanes ----------

function laneSegments(state) {
  const segments = [];
  for (const task of state.running.slice(0, 2)) segments.push({ kind: "running", text: task.title || task.id, weight: 3 });
  for (const task of state.waiting.slice(0, 1)) segments.push({ kind: "waiting", text: `Waiting: ${task.title || task.id}`, weight: 2 });
  for (const task of state.blocked.slice(0, 1)) segments.push({ kind: "blocked", text: `Blocked: ${task.title || task.id}`, weight: 2 });
  if (state.queued.length) segments.push({ kind: "queued", text: `${state.queued.length} queued`, weight: 1 });
  return segments;
}

function lanesHTML(profiles, tasks) {
  if (!profiles.length) return `<div class="empty ops-empty"><div class="empty-ico">${icon("agents")}</div><h4>No Hermes profiles</h4><p>Run the fleet configuration script to create the specialist profiles.</p></div>`;
  return `<div class="oh-lanes">${profiles.map((profile) => {
    const meta = META[profile.name] || { label: profile.name, role: "Agent", icon: "bot", color: "violet" };
    const state = fleetState(profile, tasks);
    const segments = laneSegments(state);
    return `<div class="oh-lane">
      <a class="oh-lane-label" href="#/agents"><i class="oh-dot agent-${esc(meta.color)}"></i>${esc(meta.label)}</a>
      <div class="oh-lane-track">${segments.length
        ? segments.map((segment) => `<span class="oh-bar ${segment.kind} agent-bg-${esc(meta.color)}" style="flex:${segment.weight}" title="${esc(segment.text)}">${esc(segment.text)}</span>`).join("")
        : `<span class="oh-bar idle">Idle — ready for work</span>`}</div>
    </div>`;
  }).join("")}</div>`;
}

// ---------- page ----------

function loadingHTML() {
  return `<div class="oh-kpis mb-4">${Array.from({ length: 4 }, () => `<div class="card oh-kpi"><div class="skeleton" style="height:88px"></div></div>`).join("")}</div><div class="card pad-lg"><div class="skeleton" style="height:360px"></div></div>`;
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
  const profiles = data.profiles.profiles || [];
  const pulse = data.pulse;
  const host = pulse.host || {};
  const history = pulse.history || [];
  const missionsDone = pulse.missions?.doneThisWeek ?? 0;
  const missionsPrev = pulse.missions?.donePrevWeek ?? 0;
  const attention = attentionItems(data);
  const workspace = data.onboarding.workspace?.name || "Agentic OS";
  const servicesOk = [data.hermes.ready, data.mila.ok, data.claude.ready, data.knowledge.ready].filter(Boolean).length;

  const missionDelta = missionsDone === missionsPrev
    ? `<span class="oh-delta flat">same as last week</span>`
    : `<span class="oh-delta ${missionsDone > missionsPrev ? "up" : "down"}">${missionsDone > missionsPrev ? "▲" : "▼"} ${Math.abs(missionsDone - missionsPrev)} vs last week</span>`;

  return `
    <div class="page-head operational-head">
      <div>
        <div class="page-title">Operational Home</div>
        <div class="page-sub">${esc(workspace)} · ${servicesOk} of 4 services ready · ${pulse.approvals.length} approval${pulse.approvals.length === 1 ? "" : "s"} waiting · updated ${esc(age(data.checkedAt))}</div>
      </div>
      <div class="spacer"></div>
      <button class="btn btn-secondary" id="dashboardRefresh">${icon("refresh")}Refresh</button>
      ${api.auth.canWrite ? `<a class="btn btn-primary" href="#/kanban/new">${icon("plus")}New task</a>` : ""}
    </div>

    <div class="oh-pulse mb-4">
      ${svc(data.hermes.ready, "Hermes", data.hermes.ready ? "Bridge ready" : "Unreachable", "#/hermes")}
      ${svc(data.mila.ok && data.mila.voiceConfigured, "MILA", data.mila.ok ? (data.mila.liveModel || "Voice ready") : "Unavailable", "#/mila")}
      ${svc(data.claude.ready && data.claude.auth?.loggedIn, "Claude", data.claude.ready ? (data.claude.model?.resolved || "Authenticated") : "Unavailable", "#/claude")}
      ${svc(data.knowledge.ready && data.knowledge.writable, "Vault", `${data.knowledge.notes || 0} notes`, "#/knowledge")}
      ${svc(backup.status === "success", "Backup", backup.status === "success" ? age(backup.lastSuccessAt) : "Not verified", "#/observability")}
      ${svc(!host.disk || host.disk.usedPct < 85, "Disk", host.disk ? `${host.disk.usedPct}% used` : "No probe", "#/observability")}
    </div>

    <div class="oh-top mb-4">
      <section class="card oh-attn-card">
        <div class="card-head"><div><h3>Needs your attention</h3><p class="hint">Approvals, blockers and warnings — the one list to read</p></div></div>
        ${attention.length ? `<div class="oh-attn">${attention.map((item) => `
          <div class="oh-attn-item">
            <span class="oh-sev ${esc(item.sev)}"></span>
            <div class="oh-attn-body"><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></div>
            <div class="oh-attn-actions">${item.actions}</div>
          </div>`).join("")}</div>`
        : `<div class="empty ops-empty"><div class="empty-ico">${icon("check")}</div><h4>Nothing needs you right now</h4><p>Approvals, blockers and operational warnings appear here first.</p></div>`}
      </section>

      <div class="oh-kpis">
        ${kpi("Open work", String(open.length), deltaAgainst(history, "open", open.length), sparkline(seriesFrom(history, "open")), "#/kanban")}
        ${kpi("Pending approvals", String(pulse.approvals.length), deltaAgainst(history, "approvals", pulse.approvals.length), sparkline(seriesFrom(history, "approvals")), "#/missions")}
        ${kpi("Active routines", String(activeRoutines.length), deltaAgainst(history, "routines", activeRoutines.length), sparkline(seriesFrom(history, "routines")), "#/routines")}
        ${kpi("Missions done · 7d", String(missionsDone), missionDelta, sparkline((pulse.missions?.days || []).map((day) => day.done)), "#/missions")}
      </div>
    </div>

    <div class="oh-mid mb-4">
      <section class="card">
        <div class="card-head ops-card-head"><div><h3>Fleet focus</h3><p class="hint">What each profile is doing right now · ${running.length} running · ${blocked.length} blocked</p></div><a class="btn btn-ghost sm" href="#/kanban">Open board ${icon("arrowright")}</a></div>
        ${lanesHTML(profiles, tasks)}
      </section>

      <section class="card">
        <div class="card-head"><div><h3>Live activity</h3><p class="hint">Runtime, knowledge and mission events</p></div></div>
        <div class="oh-feed" id="ohFeed">
          ${(() => { const entries = feedEntries(data); return entries.length
            ? entries.map((entry) => feedItemHTML(entry)).join("")
            : `<div class="empty ops-empty"><div class="empty-ico">${icon("observability")}</div><h4>No recent events</h4><p>Agent activity streams in here as it happens.</p></div>`; })()}
        </div>
      </section>
    </div>

    <div class="oh-low">
      <section class="card pad-lg">
        <div class="card-head"><div><h3>Hermes fleet</h3><p class="hint">Persistent specialist profiles</p></div><a class="btn btn-ghost sm" href="#/agents">Manage</a></div>
        <div class="ops-fleet">${profiles.map((profile) => {
          const meta = META[profile.name] || { label: profile.name, role: "Agent", icon: "bot", color: "violet" };
          const state = fleetState(profile, tasks);
          const focus = state.running[0]?.title || (state.waiting[0] ? `Waiting: ${state.waiting[0].title}` : state.blocked[0] ? `Blocked: ${state.blocked[0].title}` : state.queued.length ? `${state.queued.length} queued` : "Idle");
          return `<a class="ops-agent" href="#/agents"><span class="kanban-agent-icon ${esc(meta.color)}">${icon(meta.icon)}</span><span><strong>${esc(meta.label)}</strong><small>${esc(meta.role)} · ${esc(focus)}</small></span><span class="badge ${state.tone}">${esc(state.label)}</span></a>`;
        }).join("")}</div>
      </section>

      <section class="card pad-lg">
        <div class="card-head"><div><h3>Four C</h3><p class="hint">Current product readiness</p></div><span class="badge ${statusTone(readiness.status)}">${esc(readiness.score || 0)}%</span></div>
        <div class="stack gap-3">${(readiness.sections || []).map((section) => `<a class="ops-progress" href="#/observability"><div class="row between"><span>${esc(section.label)}</span><strong>${esc(section.score)}%</strong></div><div class="progress"><span style="width:${Math.max(0, Math.min(100, Number(section.score) || 0))}%"></span></div></a>`).join("")}</div>
      </section>

      <section class="card pad-lg">
        <div class="card-head"><div><h3>Host</h3><p class="hint">Server probes from the app container</p></div></div>
        ${host.disk ? `<div class="oh-meter ${host.disk.usedPct >= 85 ? "warn" : ""}">
          <div class="row between"><span>Disk</span><strong class="mono">${gb(host.disk.totalBytes - host.disk.freeBytes)} / ${gb(host.disk.totalBytes)}</strong></div>
          <div class="progress"><span style="width:${host.disk.usedPct}%"></span></div>
          <small class="hint">${gb(host.disk.freeBytes)} free · warning at 85%</small>
        </div>` : ""}
        ${host.memory ? `<div class="oh-meter">
          <div class="row between"><span>Memory</span><strong class="mono">${gb(host.memory.totalBytes - host.memory.freeBytes)} / ${gb(host.memory.totalBytes)}</strong></div>
          <div class="progress"><span style="width:${host.memory.usedPct}%"></span></div>
        </div>` : ""}
        ${host.cpu ? `<div class="oh-meter">
          <div class="row between"><span>CPU load · ${host.cpu.cores} cores</span><strong class="mono">${host.cpu.loadPct}%</strong></div>
          <div class="progress"><span style="width:${host.cpu.loadPct}%"></span></div>
        </div>` : ""}
        <div class="stack gap-2" style="margin-top:12px">
          <div class="oh-hostrow"><span>${icon("check")}</span><span>Backup: <strong>${esc(backup.status || "unknown")}</strong>${backup.lastSuccessAt ? ` · ${esc(age(backup.lastSuccessAt))}` : ""}</span></div>
          <div class="oh-hostrow"><span>${icon("check")}</span><span>Restore drill: <strong>${esc((data.operations.restoreDrill || {}).status || "never run")}</strong></span></div>
        </div>
      </section>
    </div>`;
}

async function loadDashboard(force = false) {
  if (dashboardLoading && !force) return;
  dashboardLoading = true;
  const results = await Promise.allSettled([
    // pulse first: it grabs a connection before the slow probes queue up
    bounded(api.pulse.status(), { host: {}, approvals: [], approvalsAvailable: false, events: [], history: [], missions: null }, 8000),
    bounded(api.operations.status(), { status: "unknown", readiness: { score: 0, sections: [], recommendations: [] }, backup: {}, restoreDrill: {} }),
    bounded(api.kanban.board(), { columns: [] }),
    bounded(api.kanban.profiles(), { profiles: [] }),
    bounded(api.routines.list("all"), []),
    bounded(api.knowledge.status(), {}),
    bounded(api.knowledge.usage(12), []),
    bounded(api.hermes.status(), { ready: false, error: "Timed out" }, 3500),
    bounded(api.claude.status(true), { ready: false, error: "Timed out" }, 5000),
    bounded(api.integrations.milaStatus(), { ok: false, error: "Timed out" }, 3500),
    bounded(api.onboarding.get(), { workspace: {} }),
    bounded(api.missions.list(), []),
  ]);
  const critical = [results[0], results[1], results[2]];
  if (critical.every((result) => result.status === "rejected")) {
    dashboardError = critical[0].reason?.message || "Operational data is unavailable";
    dashboardState = null;
  } else {
    dashboardState = {
      pulse: value(results[0], { host: {}, approvals: [], approvalsAvailable: false, events: [], history: [], missions: null }),
      operations: value(results[1], { status: "unknown", readiness: { score: 0, sections: [], recommendations: [] }, backup: {} }),
      board: value(results[2], { columns: [] }),
      profiles: value(results[3], { profiles: [] }),
      routines: value(results[4], []),
      knowledge: value(results[5], {}),
      usage: value(results[6], []),
      hermes: value(results[7], {}),
      claude: value(results[8], {}),
      mila: value(results[9], {}),
      onboarding: value(results[10], { workspace: {} }),
      missions: value(results[11], []),
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
    root.querySelectorAll("[data-approval]").forEach((button) => button.addEventListener("click", async (event) => {
      const { approval, decision } = event.currentTarget.dataset;
      event.currentTarget.disabled = true;
      try {
        await api.pulse.decideApproval(approval, decision);
        toast("success", decision === "approve" ? "Approved — the runtime continues" : "Denied — the runtime stops this action");
        await loadDashboard(true);
      } catch (error) {
        event.currentTarget.disabled = false;
        toast("error", error.message);
      }
    }));
    if (!dashboardState && !dashboardLoading) loadDashboard();
    dashboardPoll = setInterval(() => loadDashboard(true), 30000);
    if (api.on && !liveStream && window.EventSource) {
      try {
        liveStream = api.pulse.stream(Date.now(), (entry) => {
          liveEvents = [...liveEvents, entry].slice(-30);
          const feed = document.getElementById("ohFeed");
          if (feed && !feed.querySelector(".empty")) feed.insertAdjacentHTML("afterbegin", feedItemHTML(entry, true));
          else if (feed) feed.innerHTML = feedItemHTML(entry, true);
        });
        liveStream.onerror = () => { liveStream?.close(); liveStream = null; };
      } catch { liveStream = null; }
    }
  },
  unmount() {
    clearInterval(dashboardPoll);
    dashboardPoll = null;
    liveStream?.close();
    liveStream = null;
  },
};
