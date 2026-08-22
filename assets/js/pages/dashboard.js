import { api } from "../api.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { store, timeAgo } from "../store.js";
import { esc, toast } from "../ui.js";
import { mountNeedsYou } from "../needs-you-card.js";

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
let stopNeedsYou = null;

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
    label: t(running.length ? "dash.state.working" : blocked.length ? "dash.state.blocked"
      : waiting.length ? "dash.state.waiting" : queued.length ? "dash.state.queued" : "dash.state.ready"),
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
  if (!values || values.length < 2) return `<div class="oh-spark-empty">${t("dash.historyBuilds")}</div>`;
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
  if (!diff) return `<span class="oh-delta flat">${t("dash.noChange")}</span>`;
  return `<span class="oh-delta ${diff > 0 ? "up" : "down"}">${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)} · ${t("dash.last24h")}</span>`;
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

// ---------- database migration ----------

// The JSON-to-Postgres migration runs live behind a consistency gate that falls
// back to JSON on its own. Falling back is normal and by design; what is not
// normal is an outbox that keeps growing or a refresh that keeps failing, and
// until now none of it was visible anywhere.
const OUTBOX_WARN = 25;
const OUTBOX_FAIL = 200;

// Returns codes and numbers rather than prose, so the page decides the wording
// in the reader's language and the rules stay testable on their own.
export function databaseHealth(database = {}) {
  const outbox = database.outbox || {};
  const pending = Number(outbox.pending) || 0;
  const failures = Number(database.consecutiveFailures) || 0;
  const refreshFailures = Number(database.authReads?.refreshFailures) || 0;
  const error = [database.error, outbox.error, database.reads?.error, database.writes?.error,
    database.authReads?.error, database.authWrites?.error].filter(Boolean)[0] || "";

  const base = {
    pending, failures, refreshFailures, error,
    status: database.status || "",
    lastSuccessAt: database.lastSuccessAt || null,
    source: database.sourceOfTruth === "postgres" ? "postgres" : "hybrid",
    reasons: [],
  };
  if (!database.enabled) return { ...base, level: "off", source: "off" };

  const reasons = [];
  let level = "ok";
  const escalate = (next) => { level = level === "fail" ? "fail" : next; };
  if (error) { level = "fail"; reasons.push({ code: "error", value: String(error).slice(0, 120) }); }
  // A stale auth cache decides who can sign in, so it is never merely a warning.
  if (refreshFailures > 0) { level = "fail"; reasons.push({ code: "refreshFailures", value: refreshFailures }); }
  if (failures > 0) { escalate("warn"); reasons.push({ code: "syncFailures", value: failures }); }
  if (pending >= OUTBOX_FAIL) { level = "fail"; reasons.push({ code: "outbox", value: pending }); }
  else if (pending >= OUTBOX_WARN) { escalate("warn"); reasons.push({ code: "outbox", value: pending }); }
  if (database.status && database.status !== "ready" && level === "ok") {
    level = "warn";
    reasons.push({ code: "status", value: database.status });
  }
  return { ...base, level, reasons };
}

function databaseCopy(state) {
  if (state.level === "off") return { label: t("dash.db.jsonOnly"), detail: t("dash.db.disabled") };
  const label = t(state.source === "postgres" ? "dash.db.postgres" : "dash.db.hybrid");
  if (state.level === "ok") {
    return { label, detail: `${label} · ${t("dash.db.synced", { when: state.lastSuccessAt ? age(state.lastSuccessAt) : t("dash.never") })}` };
  }
  return { label, detail: state.reasons.map((reason) => t(`dash.db.reason.${reason.code}`, { value: reason.value })).join(" · ") };
}

// ---------- attention ----------

function attentionItems(data) {
  const items = [];
  const admin = api.auth.canAdmin;
  if (data.pulse.approvalsAvailable) {
    for (const approval of data.pulse.approvals.slice(0, 4)) {
      items.push({
        sev: "info",
        title: t("dash.approveAction", { action: approval.summary || approval.action }),
        detail: `${approval.project ? `${approval.project} · ` : ""}${t("dash.waitingReview", { age: approval.requestedAt ? age(approval.requestedAt) : t("dash.forReview") })}`,
        actions: admin
          ? `<button class="btn btn-primary sm" data-approval="${esc(approval.id)}" data-decision="approve">${t("dash.approve")}</button>
             <button class="btn btn-secondary sm" data-approval="${esc(approval.id)}" data-decision="deny">${t("dash.deny")}</button>`
          : `<a class="btn btn-secondary sm" href="#/missions">${t("dash.review")}</a>`,
      });
    }
  } else {
    items.push({ sev: "warn", title: t("dash.runtimeUnreachable"), detail: t("dash.runtimeUnreachableText"), actions: `<a class="btn btn-secondary sm" href="#/observability">${t("dash.details")}</a>` });
  }
  const tasks = tasksFrom(data.board);
  for (const task of tasks.filter((item) => item.status === "blocked" && item.block_kind !== "needs_input").slice(0, 3)) {
    items.push({ sev: "err", title: t("dash.taskBlocked", { title: task.title || task.id }), detail: task.block_reason || t("dash.assignee", { name: task.assignee || "default" }), actions: `<a class="btn btn-secondary sm" href="#/kanban">${t("dash.open")}</a>` });
  }
  for (const task of tasks.filter((item) => item.status === "blocked" && item.block_kind === "needs_input").slice(0, 2)) {
    items.push({ sev: "warn", title: t("dash.waitingInput", { title: task.title || task.id }), detail: t("dash.assignee", { name: task.assignee || "default" }), actions: `<a class="btn btn-secondary sm" href="#/kanban">${t("dash.answer")}</a>` });
  }
  const disk = data.pulse.host?.disk;
  if (disk && disk.usedPct >= 85) {
    items.push({ sev: disk.usedPct >= 93 ? "err" : "warn", title: t("dash.diskUsage", { pct: disk.usedPct }), detail: t("dash.diskFree", { free: gb(disk.freeBytes) }), actions: `<a class="btn btn-secondary sm" href="#/observability">${t("dash.details")}</a>` });
  }
  const database = databaseHealth(data.health?.database);
  if (database.level === "fail" || database.level === "warn") {
    items.push({
      sev: database.level === "fail" ? "err" : "warn",
      title: t(database.level === "fail" ? "dash.db.failTitle" : "dash.db.warnTitle"),
      detail: t("dash.db.detail", { detail: databaseCopy(database).detail }),
      actions: `<a class="btn btn-secondary sm" href="#/observability">${t("dash.details")}</a>`,
    });
  }
  const backup = data.operations.backup || {};
  if (backup.status && backup.status !== "success") {
    items.push({ sev: "warn", title: t("dash.backupNotGreen"), detail: `${t("dash.svc.backup")}: ${backup.status}`, actions: `<a class="btn btn-secondary sm" href="#/observability">${t("dash.inspect")}</a>` });
  }
  const drill = data.operations.restoreDrill || {};
  if (drill.status && drill.status !== "success") {
    items.push({ sev: "warn", title: t("dash.restoreUnverified"), detail: t("dash.restoreHint"), actions: `<a class="btn btn-secondary sm" href="#/observability">${t("dash.runDrill")}</a>` });
  }
  const recommendation = (data.operations.readiness?.recommendations || [])[0];
  if (recommendation) {
    items.push({ sev: "info", title: recommendation.title, detail: recommendation.detail || "", actions: `<a class="btn btn-secondary sm" href="${esc(recommendation.href || "#/observability")}">${t("dash.resolve")}</a>` });
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
  // GET /api/missions summarizes events as a count, not an array — only walk
  // real arrays so the feed never breaks on the summary shape.
  for (const mission of (Array.isArray(data.missions) ? data.missions : []).slice(0, 8)) {
    for (const event of (Array.isArray(mission.events) ? mission.events : []).slice(-3)) {
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
  for (const task of state.waiting.slice(0, 1)) segments.push({ kind: "waiting", text: `${t("dash.state.waiting")}: ${task.title || task.id}`, weight: 2 });
  for (const task of state.blocked.slice(0, 1)) segments.push({ kind: "blocked", text: `${t("dash.state.blocked")}: ${task.title || task.id}`, weight: 2 });
  if (state.queued.length) segments.push({ kind: "queued", text: `${state.queued.length} · ${t("dash.state.queued")}`, weight: 1 });
  return segments;
}

function lanesHTML(profiles, tasks) {
  if (!profiles.length) return `<div class="empty ops-empty"><div class="empty-ico">${icon("agents")}</div><h4>${t("dash.noProfiles")}</h4><p>${t("dash.noProfilesHint")}</p></div>`;
  return `<div class="oh-lanes">${profiles.map((profile) => {
    const meta = META[profile.name] || { label: profile.name, role: "Agent", icon: "bot", color: "violet" };
    const state = fleetState(profile, tasks);
    const segments = laneSegments(state);
    return `<div class="oh-lane">
      <a class="oh-lane-label" href="#/agents"><i class="oh-dot agent-${esc(meta.color)}"></i>${esc(meta.label)}</a>
      <div class="oh-lane-track">${segments.length
        ? segments.map((segment) => `<span class="oh-bar ${segment.kind} agent-bg-${esc(meta.color)}" style="flex:${segment.weight}" title="${esc(segment.text)}">${esc(segment.text)}</span>`).join("")
        : `<span class="oh-bar idle">${t("dash.state.idle")}</span>`}</div>
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
  const database = databaseHealth(data.health?.database);

  const dbCopy = databaseCopy(database);
  const missionDelta = missionsDone === missionsPrev
    ? `<span class="oh-delta flat">${t("dash.sameAsLastWeek")}</span>`
    : `<span class="oh-delta ${missionsDone > missionsPrev ? "up" : "down"}">${missionsDone > missionsPrev ? "▲" : "▼"} ${Math.abs(missionsDone - missionsPrev)} ${t("dash.vsLastWeek")}</span>`;

  return `
    <div class="page-head operational-head">
      <div>
        <div class="page-title">${t("dash.title")}</div>
        <div class="page-sub">${esc(t("dash.sub", { workspace, ready: servicesOk, approvals: pulse.approvals.length, age: age(data.checkedAt) }))}</div>
      </div>
      <div class="spacer"></div>
      <button class="btn btn-secondary" id="dashboardRefresh">${icon("refresh")}${t("dash.refresh")}</button>
      ${api.auth.canWrite ? `<a class="btn btn-primary" href="#/kanban/new">${icon("plus")}${t("dash.newTask")}</a>` : ""}
    </div>

    <div class="oh-pulse mb-4">
      ${svc(data.hermes.ready, "Hermes", t(data.hermes.ready ? "dash.svc.bridgeReady" : "dash.svc.unreachable"), "#/hermes")}
      ${svc(data.mila.ok && data.mila.voiceConfigured, "MILA", data.mila.ok ? (data.mila.liveModel || t("dash.svc.voiceReady")) : t("dash.svc.unavailable"), "#/mila")}
      ${svc(data.claude.ready && data.claude.auth?.loggedIn, "Claude", data.claude.ready ? (data.claude.model?.resolved || t("dash.svc.authenticated")) : t("dash.svc.unavailable"), "#/claude")}
      ${svc(data.knowledge.ready && data.knowledge.writable, "Vault", t("dash.svc.notes", { count: data.knowledge.notes || 0 }), "#/knowledge")}
      ${svc(backup.status === "success", t("dash.svc.backup"), backup.status === "success" ? age(backup.lastSuccessAt) : t("dash.svc.notVerified"), "#/observability")}
      ${svc(!host.disk || host.disk.usedPct < 85, t("dash.svc.disk"), host.disk ? t("dash.svc.diskUsed", { pct: host.disk.usedPct }) : t("dash.svc.noProbe"), "#/observability")}
      ${svc(database.level === "ok" || database.level === "off", t("dash.svc.database"), dbCopy.detail, "#/observability")}
    </div>

    <div class="oh-top mb-4">
      <section class="card oh-attn-card">
        <div class="card-head"><div><h3>${t("dash.attention")}</h3><p class="hint">${t("dash.attentionHint")}</p></div></div>
        ${attention.length ? `<div class="oh-attn">${attention.map((item) => `
          <div class="oh-attn-item">
            <span class="oh-sev ${esc(item.sev)}"></span>
            <div class="oh-attn-body"><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></div>
            <div class="oh-attn-actions">${item.actions}</div>
          </div>`).join("")}</div>`
        : `<div class="empty ops-empty"><div class="empty-ico">${icon("check")}</div><h4>${t("dash.attentionEmpty")}</h4><p>${t("dash.attentionEmptyHint")}</p></div>`}
      </section>

      <div class="oh-kpis">
        ${kpi(t("dash.kpi.openWork"), String(open.length), deltaAgainst(history, "open", open.length), sparkline(seriesFrom(history, "open")), "#/kanban")}
        ${kpi(t("dash.kpi.approvals"), String(pulse.approvals.length), deltaAgainst(history, "approvals", pulse.approvals.length), sparkline(seriesFrom(history, "approvals")), "#/missions")}
        ${kpi(t("dash.kpi.routines"), String(activeRoutines.length), deltaAgainst(history, "routines", activeRoutines.length), sparkline(seriesFrom(history, "routines")), "#/routines")}
        ${kpi(t("dash.kpi.missions"), String(missionsDone), missionDelta, sparkline((pulse.missions?.days || []).map((day) => day.done)), "#/missions")}
      </div>
    </div>

    <div class="oh-mid mb-4">
      <section class="card">
        <div class="card-head ops-card-head"><div><h3>${t("dash.fleet")}</h3><p class="hint">${t("dash.fleetHint", { running: running.length, blocked: blocked.length })}</p></div><a class="btn btn-ghost sm" href="#/kanban">${t("dash.openBoard")} ${icon("arrowright")}</a></div>
        ${lanesHTML(profiles, tasks)}
      </section>

      <section class="card">
        <div class="card-head"><div><h3>${t("dash.activity")}</h3><p class="hint">${t("dash.activityHint")}</p></div></div>
        <div class="oh-feed" id="ohFeed">
          ${(() => { const entries = feedEntries(data); return entries.length
            ? entries.map((entry) => feedItemHTML(entry)).join("")
            : `<div class="empty ops-empty"><div class="empty-ico">${icon("observability")}</div><h4>${t("dash.noEvents")}</h4><p>${t("dash.noEventsHint")}</p></div>`; })()}
        </div>
      </section>
    </div>

    <div class="oh-low">
      <section class="card pad-lg">
        <div class="card-head"><div><h3>${t("dash.hermesFleet")}</h3><p class="hint">${t("dash.hermesFleetHint")}</p></div><a class="btn btn-ghost sm" href="#/agents">${t("dash.manage")}</a></div>
        <div class="ops-fleet">${profiles.map((profile) => {
          const meta = META[profile.name] || { label: profile.name, role: "Agent", icon: "bot", color: "violet" };
          const state = fleetState(profile, tasks);
          const focus = state.running[0]?.title
            || (state.waiting[0] ? `${t("dash.state.waiting")}: ${state.waiting[0].title}`
              : state.blocked[0] ? `${t("dash.state.blocked")}: ${state.blocked[0].title}`
                : state.queued.length ? `${state.queued.length} · ${t("dash.state.queued")}` : t("dash.state.ready"));
          return `<a class="ops-agent" href="#/agents"><span class="kanban-agent-icon ${esc(meta.color)}">${icon(meta.icon)}</span><span><strong>${esc(meta.label)}</strong><small>${esc(meta.role)} · ${esc(focus)}</small></span><span class="badge ${state.tone}">${esc(state.label)}</span></a>`;
        }).join("")}</div>
      </section>

      <section class="card pad-lg">
        <div class="card-head"><div><h3>Four C</h3><p class="hint">${t("dash.readiness")}</p></div><span class="badge ${statusTone(readiness.status)}">${esc(readiness.score || 0)}%</span></div>
        <div class="stack gap-3">${(readiness.sections || []).map((section) => `<a class="ops-progress" href="#/observability"><div class="row between"><span>${esc(section.label)}</span><strong>${esc(section.score)}%</strong></div><div class="progress"><span style="width:${Math.max(0, Math.min(100, Number(section.score) || 0))}%"></span></div></a>`).join("")}</div>
      </section>

      <section class="card pad-lg">
        <div class="card-head"><div><h3>${t("dash.host")}</h3><p class="hint">${t("dash.probes")}</p></div></div>
        ${host.disk ? `<div class="oh-meter ${host.disk.usedPct >= 85 ? "warn" : ""}">
          <div class="row between"><span>${t("dash.svc.disk")}</span><strong class="mono">${gb(host.disk.totalBytes - host.disk.freeBytes)} / ${gb(host.disk.totalBytes)}</strong></div>
          <div class="progress"><span style="width:${host.disk.usedPct}%"></span></div>
          <small class="hint">${t("dash.diskWarn", { free: gb(host.disk.freeBytes) })}</small>
        </div>` : ""}
        ${host.memory ? `<div class="oh-meter">
          <div class="row between"><span>${t("dash.memory")}</span><strong class="mono">${gb(host.memory.totalBytes - host.memory.freeBytes)} / ${gb(host.memory.totalBytes)}</strong></div>
          <div class="progress"><span style="width:${host.memory.usedPct}%"></span></div>
        </div>` : ""}
        ${host.cpu ? `<div class="oh-meter">
          <div class="row between"><span>${t("dash.cpu", { cores: host.cpu.cores })}</span><strong class="mono">${host.cpu.loadPct}%</strong></div>
          <div class="progress"><span style="width:${host.cpu.loadPct}%"></span></div>
        </div>` : ""}
        <div class="stack gap-2" style="margin-top:12px">
          <div class="oh-hostrow"><span>${icon("check")}</span><span>${t("dash.svc.backup")}: <strong>${esc(backup.status || t("dash.unknown"))}</strong>${backup.lastSuccessAt ? ` · ${esc(age(backup.lastSuccessAt))}` : ""}</span></div>
          <div class="oh-hostrow"><span>${icon("check")}</span><span>${t("dash.restoreDrill")}: <strong>${esc((data.operations.restoreDrill || {}).status || t("dash.neverRun"))}</strong></span></div>
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
    bounded(api.hermes.status(), { ready: false, error: t("dash.timedOut") }, 3500),
    bounded(api.claude.status(true), { ready: false, error: t("dash.timedOut") }, 5000),
    bounded(api.integrations.milaStatus(), { ok: false, error: t("dash.timedOut") }, 3500),
    bounded(api.onboarding.get(), { workspace: {} }),
    bounded(api.missions.list(), []),
    bounded(api.healthNow(), api.health || {}, 3500),
  ]);
  const critical = [results[0], results[1], results[2]];
  if (critical.every((result) => result.status === "rejected")) {
    dashboardError = critical[0].reason?.message || t("dash.unavailable");
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
      health: value(results[12], api.health || {}),
      checkedAt: Date.now(),
    };
    dashboardError = "";
  }
  dashboardLoading = false;
  rerender();
}

export default {
  get title() { return t("dash.title"); },
  render() {
    if (!api.on) return `<div class="page-head"><div><div class="page-title">${t("dash.title")}</div><div class="page-sub">${t("dash.subOffline")}</div></div></div><div class="alert warning"><div class="a-body"><div class="a-title">${t("dash.offlineTitle")}</div><div class="a-desc">${t("dash.offlineText")}</div></div></div>`;
    if (dashboardError) return `<div class="page-head"><div><div class="page-title">${t("dash.title")}</div><div class="page-sub">${t("dash.live")}</div></div><div class="spacer"></div><button class="btn btn-secondary" id="dashboardRefresh">${icon("refresh")}${t("dash.retry")}</button></div><div class="alert error"><div class="a-body"><div class="a-title">${t("dash.loadError")}</div><div class="a-desc">${esc(dashboardError)}</div></div></div>`;
    return dashboardState ? dashboardHTML(dashboardState) : `<div class="page-head"><div><div class="page-title">${t("dash.title")}</div><div class="page-sub">${t("dash.reading")}</div></div></div>${loadingHTML()}`;
  },
  mount(root) {
    // Above everything, because it is the only part of this page describing
    // something that has stopped rather than something that is running.
    stopNeedsYou = mountNeedsYou(root);
    root.querySelector("#dashboardRefresh")?.addEventListener("click", async (event) => {
      event.currentTarget.classList.add("loading");
      await loadDashboard(true);
      toast("success", t("dash.refreshed"));
    });
    root.querySelectorAll("[data-approval]").forEach((button) => button.addEventListener("click", async (event) => {
      const { approval, decision } = event.currentTarget.dataset;
      event.currentTarget.disabled = true;
      try {
        await api.pulse.decideApproval(approval, decision);
        toast("success", decision === "approve" ? t("dash.approved") : t("dash.denied"));
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
    stopNeedsYou?.();
    stopNeedsYou = null;
    clearInterval(dashboardPoll);
    dashboardPoll = null;
    liveStream?.close();
    liveStream = null;
  },
};
