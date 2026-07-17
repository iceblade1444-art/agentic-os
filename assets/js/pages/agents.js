import { api } from "../api.js";
import { icon } from "../icons.js";
import { closeOverlay, esc, openModal } from "../ui.js";

const META = {
  default: { label: "Hermes", role: "Primary orchestrator", icon: "brain", color: "violet" },
  scout: { label: "Scout", role: "Research and intelligence", icon: "search", color: "blue" },
  scribe: { label: "Scribe", role: "Writing and documentation", icon: "edit", color: "cyan" },
  reach: { label: "Reach", role: "Growth and monetization", icon: "up", color: "amber" },
  dev: { label: "Dev", role: "Engineering and automation", icon: "code", color: "green" },
};

let host = null;
let profiles = [];
let tasks = [];
let poll = null;

const meta = (name) => META[name] || { label: name, role: "Hermes profile", icon: "bot", color: "violet" };
const count = (name, statuses) => tasks.filter((task) => task.assignee === name && statuses.includes(task.status)).length;

function statusFor(name) {
  if (count(name, ["running"])) return ["Working", "warning"];
  if (count(name, ["blocked"])) return ["Blocked", "error"];
  if (count(name, ["triage", "todo", "scheduled", "ready", "review"])) return ["Queued", "info"];
  return ["Ready", "success"];
}

function draw() {
  if (!host) return;
  const rows = host.querySelector("#fleetRows");
  const summary = host.querySelector("#fleetSummary");
  if (summary) summary.textContent = `${profiles.length} persistent profiles · ${count("default", ["running"]) + count("scout", ["running"]) + count("scribe", ["running"]) + count("reach", ["running"]) + count("dev", ["running"])} working`;
  rows.innerHTML = profiles.map((profile) => {
    const view = meta(profile.name);
    const [status, tone] = statusFor(profile.name);
    const running = count(profile.name, ["running"]);
    const queued = count(profile.name, ["triage", "todo", "scheduled", "ready", "review"]);
    const done = count(profile.name, ["done"]);
    return `<tr data-profile="${esc(profile.name)}">
      <td><div class="cell-main"><span class="kanban-agent-icon ${esc(view.color)}">${icon(view.icon)}</span><div class="stack"><strong>${esc(view.label)}</strong><span class="cell-sub">${esc(view.role)}</span></div></div></td>
      <td><span class="badge ${tone}"><span class="dot"></span>${status}</span></td>
      <td class="muted">${esc(profile.model || "Configured")}</td>
      <td class="muted">${esc(profile.provider || "Hermes")}</td>
      <td class="mono">${running}</td><td class="mono">${queued}</td><td class="mono">${done}</td>
      <td><a class="icon-btn tip" data-assign="${esc(profile.name)}" data-tip="Assign task" aria-label="Assign task" href="#/kanban/new/${esc(profile.name)}">${icon("plus")}</a></td>
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
    tasks = (board.columns || []).flatMap((column) => column.tasks || []);
    draw();
  } catch (error) {
    const rows = host?.querySelector("#fleetRows");
    if (rows) rows.innerHTML = `<tr><td colspan="8"><div class="empty"><div class="empty-ico">${icon("alert")}</div><h4>Hermes fleet unavailable</h4><p>${esc(error.message)}</p></div></td></tr>`;
  }
}

function openProfile(name) {
  const profile = profiles.find((item) => item.name === name);
  if (!profile) return;
  const view = meta(name);
  const [status, tone] = statusFor(name);
  const running = count(name, ["running"]);
  const queued = count(name, ["triage", "todo", "scheduled", "ready", "review"]);
  const blocked = count(name, ["blocked"]);
  openModal({
    title: `${view.label} · ${view.role}`, width: 640,
    body: `<div class="kanban-profile-head"><span class="kanban-agent-icon ${view.color}">${icon(view.icon)}</span><div><strong>${esc(profile.model || "Configured model")}</strong><span>${esc(profile.provider || "Hermes profile")}</span></div><span class="badge ${tone}">${status}</span></div>
      <p class="kanban-profile-description">${esc(profile.description || "No routing description configured.")}</p>
      <div class="kanban-profile-stats"><span><strong>${running}</strong>Running</span><span><strong>${queued}</strong>Queued</span><span><strong>${blocked}</strong>Blocked</span><span><strong>${profile.skill_count || 0}</strong>Skills</span></div>`,
    footer: `<a class="btn btn-secondary" href="#/hermes" data-close>${icon("settings")}Configure</a><button class="btn btn-primary" id="fleetAssign">${icon("plus")}Assign task</button>`,
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
    <div class="page-head"><div><div class="page-title">Hermes Fleet</div><div class="page-sub" id="fleetSummary">Loading persistent profiles…</div></div><div class="spacer"></div><a class="btn btn-secondary" href="#/hermes">${icon("settings")}Hermes profiles</a><a class="btn btn-primary" href="#/kanban/new">${icon("plus")}Assign task</a></div>
    <div class="card" style="padding:0"><div class="table-wrap"><table class="tbl"><thead><tr><th>Agent</th><th>Status</th><th>Model</th><th>Provider</th><th>Running</th><th>Queued</th><th>Done</th><th></th></tr></thead><tbody id="fleetRows"><tr><td colspan="8"><div class="skeleton" style="height:180px"></div></td></tr></tbody></table></div></div>
  </div>`,
  mount(root) {
    host = root;
    load();
    poll = setInterval(load, 5000);
  },
  unmount() {
    clearInterval(poll);
    poll = null;
    host = null;
  },
};
