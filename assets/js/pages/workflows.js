import { api } from "../api.js";
import { icon } from "../icons.js";
import { closeOverlay, confirmDialog, esc, openModal, toast } from "../ui.js";

const COLUMNS = [
  { id: "triage", label: "Triage", icon: "inbox", tone: "neutral" },
  { id: "todo", label: "Todo", icon: "list", tone: "neutral" },
  { id: "scheduled", label: "Scheduled", icon: "clock", tone: "info" },
  { id: "ready", label: "Ready", icon: "play", tone: "success" },
  { id: "running", label: "Running", icon: "activity", tone: "warning" },
  { id: "review", label: "Review", icon: "eye", tone: "info" },
  { id: "blocked", label: "Blocked", icon: "alert", tone: "error" },
  { id: "done", label: "Done", icon: "check", tone: "success" },
];

const PROFILE_META = {
  default: { label: "Hermes", role: "Orchestrator", icon: "brain", color: "violet" },
  scout: { label: "Scout", role: "Research", icon: "search", color: "blue" },
  scribe: { label: "Scribe", role: "Writing", icon: "edit", color: "cyan" },
  reach: { label: "Reach", role: "Growth", icon: "up", color: "amber" },
  dev: { label: "Dev", role: "Engineering", icon: "code", color: "green" },
};

let pageRoot = null;
let board = null;
let profiles = [];
let orchestration = null;
let pollTimer = null;
let loading = false;

const taskList = () => (board?.columns || []).flatMap((column) => column.tasks || []);
const column = (status) => board?.columns?.find((item) => item.name === status)?.tasks || [];
const profileMeta = (name) => PROFILE_META[name] || { label: name || "Unassigned", role: "Specialist", icon: "bot", color: "violet" };
const priorityLabel = (value) => ["Normal", "High", "Urgent", "Critical"][Math.max(0, Math.min(3, Number(value) || 0))];

function age(timestamp) {
  if (!timestamp) return "now";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - Number(timestamp)));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function profileOptions(selected = "default") {
  return profiles.map((profile) => {
    const meta = profileMeta(profile.name);
    return `<option value="${esc(profile.name)}"${profile.name === selected ? " selected" : ""}>${esc(meta.label)} · ${esc(meta.role)}</option>`;
  }).join("");
}

function agentState(name) {
  const tasks = taskList().filter((task) => task.assignee === name);
  const running = tasks.filter((task) => task.status === "running").length;
  const queued = tasks.filter((task) => ["triage", "todo", "scheduled", "ready", "review"].includes(task.status)).length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  return { running, queued, blocked, label: running ? "Working" : blocked ? "Blocked" : queued ? "Queued" : "Ready" };
}

function renderFleet() {
  const host = pageRoot?.querySelector("#kanbanFleet");
  if (!host) return;
  host.innerHTML = profiles.map((profile) => {
    const meta = profileMeta(profile.name);
    const state = agentState(profile.name);
    return `<button class="kanban-agent" type="button" data-profile="${esc(profile.name)}">
      <span class="kanban-agent-icon ${esc(meta.color)}">${icon(meta.icon)}</span>
      <span class="kanban-agent-copy"><strong>${esc(meta.label)}</strong><small>${esc(meta.role)}</small></span>
      <span class="kanban-agent-state ${state.running ? "running" : state.blocked ? "blocked" : ""}"><i></i>${state.label}</span>
      <span class="kanban-agent-count">${state.running ? `${state.running} running` : state.queued ? `${state.queued} queued` : profile.model || ""}</span>
    </button>`;
  }).join("");
  host.querySelectorAll("[data-profile]").forEach((button) => {
    button.onclick = () => openProfile(button.dataset.profile);
  });
}

function cardHTML(task) {
  const meta = profileMeta(task.assignee);
  const progress = task.progress?.total ? `<span>${task.progress.done}/${task.progress.total} children</span>` : "";
  const warnings = task.warnings?.count ? `<span class="kanban-warning">${icon("warn")}${task.warnings.count}</span>` : "";
  return `<article class="kanban-card" draggable="true" data-task-id="${esc(task.id)}" tabindex="0">
    <div class="kanban-card-top"><code>${esc(task.id)}</code><span class="kanban-priority p${Number(task.priority) || 0}">${priorityLabel(task.priority)}</span></div>
    <h3>${esc(task.title)}</h3>
    ${task.latest_summary ? `<p>${esc(task.latest_summary)}</p>` : ""}
    <div class="kanban-card-meta">
      <span class="kanban-assignee"><i class="${esc(meta.color)}">${icon(meta.icon)}</i>${esc(meta.label)}</span>
      <span>${icon("chat")}${Number(task.comment_count) || 0}</span>
      ${progress}${warnings}<time>${age(task.created_at)}</time>
    </div>
  </article>`;
}

function renderBoard() {
  const host = pageRoot?.querySelector("#kanbanBoard");
  if (!host) return;
  host.innerHTML = COLUMNS.map((item) => {
    const tasks = column(item.id);
    return `<section class="kanban-column" data-status="${item.id}">
      <header><span class="kanban-column-icon ${item.tone}">${icon(item.icon)}</span><strong>${item.label}</strong><span class="kanban-column-count">${tasks.length}</span><button class="icon-btn tip" data-add-status="${item.id}" data-tip="New task" aria-label="New ${item.label} task">${icon("plus")}</button></header>
      <div class="kanban-column-body">${tasks.length ? tasks.map(cardHTML).join("") : `<div class="kanban-column-empty">No tasks</div>`}</div>
    </section>`;
  }).join("");

  host.querySelectorAll("[data-add-status]").forEach((button) => {
    button.onclick = () => openCreateTask(button.dataset.addStatus === "running" ? "ready" : button.dataset.addStatus);
  });
  host.querySelectorAll("[data-task-id]").forEach((card) => {
    card.onclick = () => openTask(card.dataset.taskId);
    card.onkeydown = (event) => { if (event.key === "Enter") openTask(card.dataset.taskId); };
    card.ondragstart = (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", card.dataset.taskId);
      card.classList.add("dragging");
    };
    card.ondragend = () => card.classList.remove("dragging");
  });
  host.querySelectorAll(".kanban-column-body").forEach((lane) => {
    lane.ondragover = (event) => { event.preventDefault(); lane.classList.add("drag-over"); };
    lane.ondragleave = () => lane.classList.remove("drag-over");
    lane.ondrop = (event) => {
      event.preventDefault();
      lane.classList.remove("drag-over");
      const id = event.dataTransfer.getData("text/plain");
      const status = lane.closest("[data-status]").dataset.status;
      moveTask(id, status);
    };
  });
}

function renderSummary() {
  const summary = pageRoot?.querySelector("#kanbanSummary");
  if (summary) summary.textContent = `${taskList().length} tasks · ${column("running").length} running · ${column("blocked").length} blocked`;
  const mode = pageRoot?.querySelector("#kanbanMode");
  if (mode && orchestration) {
    mode.className = `btn sm ${orchestration.auto_decompose ? "btn-primary" : "btn-secondary"}`;
    mode.innerHTML = `${icon("branch")}Auto-plan ${orchestration.auto_decompose ? "on" : "off"}`;
  }
}

function draw() {
  renderSummary();
  renderFleet();
  renderBoard();
  const error = pageRoot?.querySelector("#kanbanError");
  error?.classList.add("hidden");
}

async function loadBoard({ quiet = false } = {}) {
  if (loading) return;
  loading = true;
  try {
    board = await api.kanban.board();
    draw();
  } catch (error) {
    const box = pageRoot?.querySelector("#kanbanError");
    if (box) {
      box.classList.remove("hidden");
      box.querySelector("span").textContent = error.message;
    }
    if (!quiet) toast("error", "Kanban unavailable", error.message);
  } finally { loading = false; }
}

async function loadAll() {
  try {
    const [boardResult, profileResult, orchestrationResult] = await Promise.all([
      api.kanban.board(), api.kanban.profiles(), api.kanban.orchestration(),
    ]);
    board = boardResult;
    profiles = profileResult.profiles || [];
    orchestration = orchestrationResult;
    draw();
  } catch (error) {
    const box = pageRoot?.querySelector("#kanbanError");
    if (box) { box.classList.remove("hidden"); box.querySelector("span").textContent = error.message; }
  }
}

function openCreateTask(initialStatus = "triage", assignedProfile = "default") {
  const allowed = ["triage", "todo", "ready"];
  const status = allowed.includes(initialStatus) ? initialStatus : "triage";
  openModal({
    title: "New Kanban task", width: 620,
    body: `<div class="field"><label class="label" for="kanbanTaskTitle">Title</label><input class="input" id="kanbanTaskTitle" maxlength="240" placeholder="What should the fleet accomplish?"/></div>
      <div class="field"><label class="label" for="kanbanTaskBody">Definition of done</label><textarea class="textarea" id="kanbanTaskBody" rows="5" placeholder="Context, expected result, constraints and verification…"></textarea></div>
      <div class="kanban-form-grid">
        <div class="field"><label class="label" for="kanbanTaskStatus">Start in</label><select class="select" id="kanbanTaskStatus">
          <option value="triage"${status === "triage" ? " selected" : ""}>Triage · Hermes plans and delegates</option>
          <option value="ready"${status === "ready" ? " selected" : ""}>Ready · Run assigned profile</option>
          <option value="todo"${status === "todo" ? " selected" : ""}>Todo · Hold for later</option>
        </select></div>
        <div class="field"><label class="label" for="kanbanTaskAssignee">Assignee</label><select class="select" id="kanbanTaskAssignee">${profileOptions(assignedProfile)}</select></div>
        <div class="field"><label class="label" for="kanbanTaskPriority">Priority</label><select class="select" id="kanbanTaskPriority"><option value="0">Normal</option><option value="1">High</option><option value="2">Urgent</option><option value="3">Critical</option></select></div>
      </div>
      <div class="kanban-form-note" id="kanbanTaskNote">Hermes will break this goal into specialist tasks and track their handoffs.</div>`,
    footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="kanbanCreateTask">${icon("plus")}Create task</button>`,
    onMount: (modal) => {
      const statusInput = modal.querySelector("#kanbanTaskStatus");
      const assignee = modal.querySelector("#kanbanTaskAssignee");
      const note = modal.querySelector("#kanbanTaskNote");
      const syncMode = () => {
        const triage = statusInput.value === "triage";
        assignee.disabled = triage;
        if (triage) assignee.value = "default";
        note.textContent = triage
          ? "Hermes will break this goal into specialist tasks and track their handoffs."
          : statusInput.value === "ready" ? "The selected profile will start when the dispatcher claims the task." : "The task stays parked until you move it to Ready.";
      };
      statusInput.onchange = syncMode;
      syncMode();
      modal.querySelector("#kanbanCreateTask").onclick = async () => {
        const title = modal.querySelector("#kanbanTaskTitle").value.trim();
        if (!title) return toast("error", "Task title is required");
        const button = modal.querySelector("#kanbanCreateTask");
        button.classList.add("loading");
        try {
          await api.kanban.createTask({
            title,
            body: modal.querySelector("#kanbanTaskBody").value.trim(),
            initialStatus: statusInput.value,
            assignee: assignee.value,
            priority: Number(modal.querySelector("#kanbanTaskPriority").value),
          });
          closeOverlay();
          toast("success", "Task created", statusInput.value === "triage" ? "Hermes will plan the work" : "Kanban updated");
          await api.kanban.dispatch().catch(() => {});
          await loadBoard();
        } catch (error) { toast("error", "Task creation failed", error.message); }
        finally { button.classList.remove("loading"); }
      };
    },
  });
}

function taskActivity(data) {
  const items = [...(data.comments || []).map((item) => ({ ...item, kind: "comment" })), ...(data.events || [])]
    .sort((a, b) => Number(b.created_at || b.at || 0) - Number(a.created_at || a.at || 0)).slice(0, 12);
  if (!items.length) return `<div class="kanban-activity-empty">No activity yet</div>`;
  return items.map((item) => `<div class="kanban-activity-item"><span>${icon(item.kind === "comment" ? "chat" : "activity")}</span><div><strong>${esc(item.author || item.kind || "event")}</strong><p>${esc(item.body || item.message || item.payload?.message || "Status updated")}</p></div><time>${age(item.created_at || item.at)}</time></div>`).join("");
}

async function openTask(id) {
  try {
    const data = await api.kanban.task(id);
    const task = data.task;
    const meta = profileMeta(task.assignee);
    openModal({
      title: task.title, width: 760,
      body: `<div class="kanban-detail-meta"><code>${esc(task.id)}</code><span class="badge neutral">${esc(task.status)}</span><span class="kanban-priority p${Number(task.priority) || 0}">${priorityLabel(task.priority)}</span></div>
        ${task.body ? `<div class="kanban-detail-body">${esc(task.body)}</div>` : ""}
        ${(task.latest_summary || task.result) ? `<section class="kanban-result"><strong>Latest handoff</strong><p>${esc(task.latest_summary || task.result)}</p></section>` : ""}
        <div class="kanban-detail-controls">
          <div class="field"><label class="label">Assignee</label><select class="select" id="kanbanDetailAssignee">${profileOptions(task.assignee)}</select></div>
          <div class="field"><label class="label">Priority</label><select class="select" id="kanbanDetailPriority">${[0, 1, 2, 3].map((value) => `<option value="${value}"${Number(task.priority) === value ? " selected" : ""}>${priorityLabel(value)}</option>`).join("")}</select></div>
        </div>
        <div class="kanban-detail-actions">
          ${task.status === "triage" ? `<button class="btn btn-secondary sm" id="kanbanDecompose">${icon("branch")}Decompose</button>` : ""}
          ${!["ready", "running", "review", "done", "archived"].includes(task.status) ? `<button class="btn btn-primary sm" id="kanbanStart">${icon("play")}Move to Ready</button>` : ""}
          ${!["done", "archived"].includes(task.status) ? `<button class="btn btn-ghost sm" id="kanbanBlock">${icon("alert")}Block</button><button class="btn btn-ghost sm" id="kanbanDone">${icon("check")}Mark done</button>` : ""}
        </div>
        <section class="kanban-activity"><h4>Activity</h4>${taskActivity(data)}</section>
        <div class="kanban-comment"><textarea class="textarea" id="kanbanComment" rows="2" placeholder="Add context or instructions for the assigned agent…"></textarea><button class="btn btn-secondary" id="kanbanAddComment">${icon("send")}Comment</button></div>`,
      footer: `<button class="btn btn-ghost" id="kanbanArchive">${icon("trash")}Archive</button><div class="spacer"></div><button class="btn btn-secondary" data-close>Close</button>`,
      onMount: (modal) => {
        const update = async (patch, message) => {
          try { await api.kanban.updateTask(id, patch); closeOverlay(); toast("success", message); await loadBoard(); }
          catch (error) { toast("error", "Kanban update failed", error.message); }
        };
        modal.querySelector("#kanbanDetailAssignee").onchange = (event) => update({ assignee: event.target.value }, `Assigned to ${profileMeta(event.target.value).label}`);
        modal.querySelector("#kanbanDetailPriority").onchange = (event) => update({ priority: Number(event.target.value) }, "Priority updated");
        modal.querySelector("#kanbanStart")?.addEventListener("click", () => update({ status: "ready" }, "Task moved to Ready"));
        modal.querySelector("#kanbanDecompose")?.addEventListener("click", async () => {
          try { await api.kanban.decompose(id); closeOverlay(); toast("success", "Hermes decomposed the task"); await loadBoard(); }
          catch (error) { toast("error", "Decomposition failed", error.message); }
        });
        modal.querySelector("#kanbanBlock")?.addEventListener("click", () => openBlockTask(id));
        modal.querySelector("#kanbanDone")?.addEventListener("click", () => moveTask(id, "done"));
        modal.querySelector("#kanbanArchive").onclick = () => moveTask(id, "archived");
        modal.querySelector("#kanbanAddComment").onclick = async () => {
          const body = modal.querySelector("#kanbanComment").value.trim();
          if (!body) return;
          try { await api.kanban.comment(id, { body }); closeOverlay(); toast("success", "Comment added"); await loadBoard(); }
          catch (error) { toast("error", "Comment failed", error.message); }
        };
      },
    });
  } catch (error) { toast("error", "Task unavailable", error.message); }
}

function openProfile(name) {
  const profile = profiles.find((item) => item.name === name);
  if (!profile) return;
  const meta = profileMeta(name);
  const state = agentState(name);
  openModal({
    title: `${meta.label} · ${meta.role}`, width: 620,
    body: `<div class="kanban-profile-head"><span class="kanban-agent-icon ${meta.color}">${icon(meta.icon)}</span><div><strong>${esc(profile.model || "Configured model")}</strong><span>${esc(profile.provider || "Hermes profile")}</span></div><span class="badge ${state.running ? "warning" : "success"}">${state.label}</span></div>
      <p class="kanban-profile-description">${esc(profile.description || "No routing description configured.")}</p>
      <div class="kanban-profile-stats"><span><strong>${state.running}</strong>Running</span><span><strong>${state.queued}</strong>Queued</span><span><strong>${state.blocked}</strong>Blocked</span><span><strong>${profile.skill_count || 0}</strong>Skills</span></div>`,
    footer: `<a class="btn btn-secondary" href="#/hermes" data-close>${icon("settings")}Hermes profile</a><button class="btn btn-primary" id="kanbanAssignProfile">${icon("plus")}Assign task</button>`,
    onMount: (modal) => {
      modal.querySelector("#kanbanAssignProfile").onclick = () => { closeOverlay(); openCreateTask("ready", name); };
    },
  });
}

function openBlockTask(id) {
  openModal({
    title: "Block task", width: 520,
    body: `<div class="field"><label class="label" for="kanbanBlockReason">What is needed to continue?</label><textarea class="textarea" id="kanbanBlockReason" rows="4" placeholder="Missing access, decision, dependency or capability…"></textarea></div>`,
    footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="kanbanConfirmBlock">${icon("alert")}Block task</button>`,
    onMount: (modal) => {
      modal.querySelector("#kanbanConfirmBlock").onclick = async () => {
        const reason = modal.querySelector("#kanbanBlockReason").value.trim();
        if (!reason) return toast("error", "Block reason is required");
        try { await api.kanban.updateTask(id, { status: "blocked", block_reason: reason }); closeOverlay(); await loadBoard(); }
        catch (error) { toast("error", "Could not block task", error.message); }
      };
    },
  });
}

function moveTask(id, status) {
  const task = taskList().find((item) => item.id === id);
  if (!task || task.status === status) return;
  if (status === "running") return toast("info", "Running is automatic", "Move a task to Ready and the Hermes dispatcher will claim it");
  if (status === "blocked") return openBlockTask(id);
  const apply = async () => {
    try { await api.kanban.updateTask(id, { status }); closeOverlay(); toast("success", "Task updated", `${task.title} → ${status}`); await loadBoard(); }
    catch (error) { toast("error", "Kanban update failed", error.message); }
  };
  if (["done", "archived"].includes(status)) {
    return confirmDialog({
      title: status === "done" ? "Mark task done?" : "Archive task?",
      message: status === "done" ? "Use this only when the result is verified." : "The task will leave the active board.",
      confirmText: status === "done" ? "Mark done" : "Archive",
      onConfirm: apply,
    });
  }
  apply();
}

export default {
  title: "Kanban",
  render: () => `<div class="kanban-page">
    <div class="page-head kanban-head"><div><div class="page-title">Hermes Kanban</div><div class="page-sub" id="kanbanSummary">Loading the shared fleet board…</div></div><div class="spacer"></div>
      <button class="btn btn-secondary sm" id="kanbanMode">${icon("branch")}Auto-plan</button>
      <button class="icon-btn tip" id="kanbanRefresh" data-tip="Refresh" aria-label="Refresh Kanban">${icon("refresh")}</button>
      <button class="btn btn-primary" id="kanbanNew">${icon("plus")}New task</button>
    </div>
    <div class="kanban-fleet" id="kanbanFleet"><div class="skeleton" style="height:76px"></div></div>
    <div class="alert error hidden" id="kanbanError"><span>Hermes Kanban is unavailable</span></div>
    <div class="kanban-board" id="kanbanBoard">${COLUMNS.map((item) => `<section class="kanban-column"><header><strong>${item.label}</strong></header><div class="kanban-column-body"><div class="skeleton" style="height:112px"></div></div></section>`).join("")}</div>
  </div>`,
  mount(root, ctx) {
    pageRoot = root;
    root.querySelector("#kanbanNew").onclick = () => openCreateTask();
    root.querySelector("#kanbanRefresh").onclick = () => loadBoard();
    root.querySelector("#kanbanMode").onclick = async () => {
      if (!orchestration) return;
      try {
        orchestration = await api.kanban.updateOrchestration({ auto_decompose: !orchestration.auto_decompose });
        renderSummary();
        toast("success", `Automatic planning ${orchestration.auto_decompose ? "enabled" : "disabled"}`);
      } catch (error) { toast("error", "Could not update orchestration", error.message); }
    };
    const [action, profile] = ctx.params || [];
    loadAll().then(() => {
      if (action === "new" && profiles.length) openCreateTask(profile ? "ready" : "triage", profile || "default");
    });
    pollTimer = setInterval(() => loadBoard({ quiet: true }), 4000);
  },
  unmount() {
    clearInterval(pollTimer);
    pollTimer = null;
    pageRoot = null;
  },
};
