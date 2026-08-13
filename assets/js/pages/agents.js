import { api } from "../api.js";
import { t } from "../i18n.js";
import { icon } from "../icons.js";
import { closeOverlay, esc, openModal, toast } from "../ui.js";

const META = {
  default: { label: "Hermes", role: t("fleet.role.default"), icon: "brain", color: "violet" },
  scout: { label: "Scout", role: t("fleet.role.scout"), icon: "search", color: "teal" },
  scribe: { label: "Scribe", role: t("fleet.role.scribe"), icon: "edit", color: "blue" },
  reach: { label: "Reach", role: t("fleet.role.reach"), icon: "up", color: "amber" },
  dev: { label: "Dev", role: t("fleet.role.dev"), icon: "code", color: "green" },
};

let host = null;
let profiles = [];
let tasks = [];
let fleetHealth = {};
let poll = null;

const meta = (name) => META[name] || { label: name, role: t("fleet.role.other"), icon: "bot", color: "violet" };
const count = (name, statuses) => tasks.filter((task) => task.assignee === name && statuses.includes(task.status)).length;
const waitingCount = (name) => tasks.filter((task) =>
  task.assignee === name && task.status === "blocked" && task.block_kind === "needs_input").length;
const failedCount = (name) => tasks.filter((task) =>
  task.assignee === name && task.status === "blocked" && task.block_kind !== "needs_input").length;

function statusFor(name) {
  const health = profiles.find((profile) => profile.name === name)?.health;
  if (health && !health.ok) {
    if (health.code === "auth_required") return [t("fleet.status.auth"), "error"];
    if (health.code === "model_error") return [t("fleet.status.modelError"), "error"];
    if (health.code === "rate_limited") return [t("fleet.status.rateLimited"), "warning"];
    return [t("fleet.status.unavailable"), "error"];
  }
  if (count(name, ["running"])) return [t("fleet.status.working"), "warning"];
  if (failedCount(name)) return [t("fleet.status.blocked"), "error"];
  if (waitingCount(name)) return [t("fleet.status.waiting"), "warning"];
  if (count(name, ["triage", "todo", "scheduled", "ready", "review"])) return [t("fleet.status.queued"), "info"];
  if (!health) return [t("fleet.status.unchecked"), "neutral"];
  if (fleetHealth.stale) return [t("fleet.status.stale"), "warning"];
  return [t("fleet.status.ready"), "success"];
}

function checkedLabel(profile) {
  const checkedAt = profile.health?.checkedAt;
  if (!checkedAt) return t("fleet.checked.never");
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(checkedAt)) / 1000));
  if (seconds < 60) return t("fleet.checked.now");
  if (seconds < 3600) return t("fleet.checked.minutes", { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("fleet.checked.hours", { n: Math.floor(seconds / 3600) });
  return t("fleet.checked.days", { n: Math.floor(seconds / 86400) });
}

function draw() {
  if (!host) return;
  const rows = host.querySelector("#fleetRows");
  const summary = host.querySelector("#fleetSummary");
  const working = profiles.reduce((total, profile) => total + count(profile.name, ["running"]), 0);
  const healthy = profiles.filter((profile) => profile.health?.ok).length;
  if (summary) summary.textContent = t("fleet.summary", { total: profiles.length, working, healthy });
  const probe = host.querySelector("#fleetProbe");
  if (probe) {
    probe.disabled = fleetHealth.status === "running";
    probe.innerHTML = fleetHealth.status === "running" ? `${icon("refresh")}${t("fleet.checking")}` : `${icon("refresh")}${t("fleet.checkModels")}`;
  }
  rows.innerHTML = profiles.map((profile) => {
    const view = meta(profile.name);
    const [status, tone] = statusFor(profile.name);
    const running = count(profile.name, ["running"]);
    const queued = count(profile.name, ["triage", "todo", "scheduled", "ready", "review"]);
    const done = count(profile.name, ["done"]);
    return `<tr data-profile="${esc(profile.name)}">
      <td><div class="cell-main"><span class="kanban-agent-icon ${esc(view.color)}">${icon(view.icon)}</span><div class="stack"><strong>${esc(view.label)}</strong><span class="cell-sub">${esc(view.role)}</span></div></div></td>
      <td><span class="badge ${tone}"><span class="dot"></span>${status}</span></td>
      <td class="muted">${esc(profile.model || t("fleet.configured"))}</td>
      <td class="muted">${esc(profile.provider || "Hermes")}</td>
      <td class="muted">${esc(checkedLabel(profile))}</td>
      <td class="mono">${running}</td><td class="mono">${queued}</td><td class="mono">${done}</td>
      <td><a class="icon-btn tip" data-assign="${esc(profile.name)}" data-tip="${t("fleet.assign")}" aria-label="${t("fleet.assign")}" href="#/kanban/new/${esc(profile.name)}">${icon("plus")}</a></td>
    </tr>`;
  }).join("");
  rows.querySelectorAll("tr[data-profile]").forEach((row) => {
    row.onclick = (event) => { if (!event.target.closest("[data-assign]")) openProfile(row.dataset.profile); };
  });
}

async function load() {
  try {
    const [profileResult, board] = await Promise.all([api.kanban.profiles(), api.kanban.board()]);
    profiles = profileResult.profiles || [];
    fleetHealth = profileResult.fleetHealth || {};
    tasks = (board.columns || []).flatMap((column) => column.tasks || []);
    draw();
  } catch (error) {
    const rows = host?.querySelector("#fleetRows");
    if (rows) rows.innerHTML = `<tr><td colspan="9"><div class="empty"><div class="empty-ico">${icon("alert")}</div><h4>${t("fleet.unavailable")}</h4><p>${esc(error.message)}</p></div></td></tr>`;
  }
}

async function probeProfiles() {
  const button = host?.querySelector("#fleetProbe");
  if (button) button.disabled = true;
  try {
    await api.kanban.probeProfiles();
    fleetHealth = { ...fleetHealth, status: "running" };
    draw();
    toast("info", t("fleet.probeStarted"), t("fleet.probeStartedHint"));
  } catch (error) {
    toast("error", t("fleet.probeFailed"), error.message);
    if (button) button.disabled = false;
  }
}

function openProfile(name) {
  const profile = profiles.find((item) => item.name === name);
  if (!profile) return;
  const view = meta(name);
  const [status, tone] = statusFor(name);
  const running = count(name, ["running"]);
  const queued = count(name, ["triage", "todo", "scheduled", "ready", "review"]);
  const waiting = waitingCount(name);
  const blocked = failedCount(name);
  const health = profile.health;
  const healthDetail = health?.ok
    ? t("fleet.healthOk", { seconds: (health.latencyMs / 1000).toFixed(1) })
    : health?.error || t("fleet.healthNever");
  openModal({
    title: `${view.label} · ${view.role}`, width: 640,
    body: `<div class="kanban-profile-head"><span class="kanban-agent-icon ${view.color}">${icon(view.icon)}</span><div><strong>${esc(profile.model || t("fleet.configuredModel"))}</strong><span>${esc(profile.provider || t("fleet.role.other"))}</span></div><span class="badge ${tone}">${status}</span></div>
      <p class="kanban-profile-description">${esc(profile.description || t("fleet.noDescription"))}</p>
      <p class="kanban-profile-description"><strong>${t("fleet.modelHealth")}</strong> ${esc(healthDetail)} ${t("fleet.checkedAt", { when: checkedLabel(profile) })}</p>
      <div class="kanban-profile-stats"><span><strong>${running}</strong>${t("fleet.col.running")}</span><span><strong>${queued}</strong>${t("fleet.col.queued")}</span><span><strong>${waiting}</strong>${t("fleet.status.waiting")}</span><span><strong>${blocked}</strong>${t("fleet.status.blocked")}</span><span><strong>${profile.skill_count || 0}</strong>${t("fleet.col.skills")}</span></div>`,
    footer: `<a class="btn btn-secondary" href="#/hermes" data-close>${icon("settings")}${t("fleet.configure")}</a><button class="btn btn-primary" id="fleetAssign">${icon("plus")}${t("fleet.assign")}</button>`,
    onMount: (modal) => {
      modal.querySelector("#fleetAssign").onclick = () => {
        closeOverlay();
        location.hash = `#/kanban/new/${name}`;
      };
    },
  });
}

export default {
  title: "Agents",
  render: () => `<div class="agent-fleet">
    <div class="page-head"><div><div class="page-title">${t("fleet.title")}</div><div class="page-sub" id="fleetSummary">${t("fleet.loading")}</div></div><div class="spacer"></div><button class="btn btn-secondary" id="fleetProbe">${icon("refresh")}${t("fleet.checkModels")}</button><a class="btn btn-secondary" href="#/hermes">${icon("settings")}${t("fleet.profiles")}</a><a class="btn btn-primary" href="#/kanban/new">${icon("plus")}${t("fleet.assign")}</a></div>
    <div class="card" style="padding:0"><div class="table-wrap"><table class="tbl"><thead><tr><th>${t("fleet.col.agent")}</th><th>${t("fleet.col.status")}</th><th>${t("fleet.col.model")}</th><th>${t("fleet.col.provider")}</th><th>${t("fleet.col.lastCheck")}</th><th>${t("fleet.col.running")}</th><th>${t("fleet.col.queued")}</th><th>${t("fleet.col.done")}</th><th></th></tr></thead><tbody id="fleetRows"><tr><td colspan="9"><div class="skeleton" style="height:180px"></div></td></tr></tbody></table></div></div>
  </div>`,
  mount(root) {
    host = root;
    host.querySelector("#fleetProbe").onclick = probeProfiles;
    load();
    poll = setInterval(load, 5000);
  },
  unmount() {
    clearInterval(poll);
    poll = null;
    host = null;
  },
};
