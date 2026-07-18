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

function duration(start, end = Date.now() / 1000) {
  if (!start) return "—";
  const seconds = Math.max(0, Math.floor(Number(end || Date.now() / 1000) - Number(start)));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function bytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
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
    ${task.status === "running" ? `<div class="kanban-card-live"><i></i><span>Run #${esc(task.current_run_id || "active")}</span><span>${duration(task.started_at)}</span></div>` : ""}
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
      <div class="kanban-form-note" id="kanbanTaskNote">Hermes will break this goal into specialist tasks and track their handoffs.</div>
      <div class="kanban-task-files"><input id="kanbanTaskFiles" type="file" multiple hidden/><button class="btn btn-secondary sm" id="kanbanSelectFiles" type="button">${icon("attach")}Attach files</button><span id="kanbanSelectedFiles">No files selected</span></div>`,
    footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="kanbanCreateTask">${icon("plus")}Create task</button>`,
    onMount: (modal) => {
      const statusInput = modal.querySelector("#kanbanTaskStatus");
      const assignee = modal.querySelector("#kanbanTaskAssignee");
      const note = modal.querySelector("#kanbanTaskNote");
      const fileInput = modal.querySelector("#kanbanTaskFiles");
      const fileSummary = modal.querySelector("#kanbanSelectedFiles");
      let selectedFiles = [];
      modal.querySelector("#kanbanSelectFiles").onclick = () => fileInput.click();
      fileInput.onchange = () => {
        selectedFiles = [...fileInput.files].filter((file) => file.size <= 25 * 1024 * 1024);
        const rejected = fileInput.files.length - selectedFiles.length;
        fileSummary.textContent = selectedFiles.length ? `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} · ${selectedFiles.map((file) => file.name).join(", ")}` : "No files selected";
        if (rejected) toast("error", "File too large", "Kanban attachments are limited to 25 MB each");
      };
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
          const created = await api.kanban.createTask({
            title,
            body: modal.querySelector("#kanbanTaskBody").value.trim(),
            initialStatus: statusInput.value,
            assignee: assignee.value,
            priority: Number(modal.querySelector("#kanbanTaskPriority").value),
          });
          const taskId = created.task?.id;
          if (taskId && selectedFiles.length) {
            fileSummary.textContent = `Uploading ${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"}…`;
            for (const file of selectedFiles) await api.kanban.uploadAttachment(taskId, file);
          }
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
    .sort((a, b) => Number(b.created_at || b.at || 0) - Number(a.created_at || a.at || 0)).slice(0, 40);
  if (!items.length) return `<div class="kanban-activity-empty">No activity yet</div>`;
  return items.map((item) => {
    const payload = item.payload || {};
    const message = item.body || item.message || payload.message || payload.summary
      || (payload.status ? `Status → ${payload.status}` : Object.keys(payload).length ? JSON.stringify(payload) : "Status updated");
    return `<div class="kanban-activity-item"><span>${icon(item.kind === "comment" ? "chat" : "activity")}</span><div><strong>${esc(item.author || item.kind || "event")}</strong><p>${esc(message)}</p></div><time>${age(item.created_at || item.at)}</time></div>`;
  }).join("");
}

function taskOverview(data) {
  const task = data.task;
  const children = data.child_results || [];
  const completed = children.filter((child) => child.status === "done").length;
  const result = task.result || task.latest_summary;
  const diagnostics = task.diagnostics || [];
  return `${task.body ? `<section class="kanban-detail-section"><h4>Definition of done</h4><div class="kanban-detail-body">${esc(task.body)}</div></section>` : ""}
    ${task.block_reason ? `<section class="kanban-detail-section danger"><h4>Blocked</h4><p>${esc(task.block_reason)}</p></section>` : ""}
    ${result ? `<section class="kanban-result"><strong>${task.result ? "Final result" : "Latest handoff"}</strong><p>${esc(result)}</p></section>` : task.status === "done" ? `<div class="kanban-detail-empty">No final result was recorded. Check Runs and Activity for worker output.</div>` : ""}
    ${children.length ? `<section class="kanban-detail-section"><div class="kanban-section-head"><h4>Child results</h4><span>${completed}/${children.length} done</span></div><div class="kanban-child-list">${children.map((child) => `<button type="button" data-child-task="${esc(child.id)}"><span><strong>${esc(child.title || child.id)}</strong><small>${esc(child.result || child.latest_summary || "No result yet")}</small></span><i class="badge neutral">${esc(child.status)}</i>${icon("chevright")}</button>`).join("")}</div></section>` : ""}
    ${diagnostics.length ? `<section class="kanban-detail-section danger"><div class="kanban-section-head"><h4>Diagnostics</h4><span>${diagnostics.length}</span></div>${diagnostics.map((item) => `<p>${esc(item.message || item.summary || JSON.stringify(item))}</p>`).join("")}</section>` : ""}`;
}

function taskRuns(data, log) {
  const runs = [...(data.runs || [])].reverse();
  const history = runs.length ? runs.map((run) => {
    const state = run.ended_at ? run.outcome || run.status || "ended" : "active";
    const metadata = run.metadata && Object.keys(run.metadata).length ? `<details><summary>Metadata</summary><pre>${esc(JSON.stringify(run.metadata, null, 2))}</pre></details>` : "";
    return `<article class="kanban-run ${run.ended_at ? "" : "active"}"><header><span class="badge ${state === "completed" || state === "done" ? "success" : state === "active" ? "warning" : "neutral"}">${esc(state)}</span><strong>@${esc(run.profile || "default")}</strong><code>#${esc(run.id)}</code><time>${duration(run.started_at, run.ended_at)}</time></header>${run.summary ? `<p>${esc(run.summary)}</p>` : ""}${run.error ? `<p class="error-text">${esc(run.error)}</p>` : ""}${metadata}</article>`;
  }).join("") : `<div class="kanban-detail-empty">No worker runs yet.</div>`;
  const logBody = !log ? `<div class="kanban-detail-empty">Loading worker log…</div>` : log.exists
    ? `<pre class="kanban-worker-log">${esc(log.content || "(empty log)")}</pre>${log.truncated ? `<small>Showing the last 100 KB.</small>` : ""}`
    : `<div class="kanban-detail-empty">No worker log yet.</div>`;
  return `<section class="kanban-detail-section"><div class="kanban-section-head"><h4>Run history</h4><span>${runs.length}</span></div><div class="kanban-run-list">${history}</div></section>
    <section class="kanban-detail-section"><div class="kanban-section-head"><h4>Worker log</h4><button type="button" class="btn btn-ghost sm" data-log-refresh>${icon("refresh")}Refresh</button></div>${logBody}</section>`;
}

function taskFiles(data) {
  const attachments = data.attachments || [];
  return `<section class="kanban-detail-section"><div class="kanban-section-head"><div><h4>Task files</h4><small>Available to the assigned agent</small></div><button type="button" class="btn btn-secondary sm" data-upload>${icon("attach")}Upload</button></div>
    <div class="kanban-file-list">${attachments.length ? attachments.map((file) => `<div class="kanban-file-row"><span>${icon(file.content_type?.startsWith("image/") ? "image" : "file")}</span><div><strong>${esc(file.filename)}</strong><small>${bytes(file.size)} · ${esc(file.uploaded_by || "Agentic OS")} · ${age(file.created_at)}</small></div><button type="button" class="icon-btn tip" data-download="${esc(file.id)}" data-tip="Download" aria-label="Download ${esc(file.filename)}">${icon("download")}</button><button type="button" class="icon-btn tip" data-remove="${esc(file.id)}" data-tip="Remove" aria-label="Remove ${esc(file.filename)}">${icon("trash")}</button></div>`).join("") : `<div class="kanban-detail-empty">No files attached.</div>`}</div></section>`;
}

function taskActivityPanel(data) {
  return `<section class="kanban-activity"><div class="kanban-section-head"><h4>Activity</h4><span>${(data.comments || []).length + (data.events || []).length}</span></div>${taskActivity(data)}</section>
    <div class="kanban-comment"><textarea class="textarea" id="kanbanComment" rows="2" placeholder="Add context or instructions for the assigned agent…"></textarea><button class="btn btn-secondary" data-comment>${icon("send")}Comment</button></div>`;
}

async function openTask(id) {
  try {
    let data = await api.kanban.task(id);
    let log = null;
    let activeTab = "overview";
    const task = data.task;
    const meta = profileMeta(task.assignee);
    const lastRun = (data.runs || []).at(-1);
    openModal({
      title: task.title, width: 960,
      body: `<div class="kanban-detail-meta"><code>${esc(task.id)}</code><span class="badge neutral" id="kanbanDetailStatus">${esc(task.status)}</span><span class="kanban-priority p${Number(task.priority) || 0}">${priorityLabel(task.priority)}</span><span class="kanban-detail-live" id="kanbanDetailLive">${task.status === "running" ? `<i></i>Live · ${duration(task.started_at)}` : `${icon("clock")}${duration(task.started_at, task.completed_at)}`}</span></div>
        <div class="kanban-detail-stats"><span><small>Agent</small><strong>${esc(meta.label)}</strong></span><span><small>Run</small><strong>${esc(task.current_run_id ? `#${task.current_run_id}` : lastRun?.id ? `#${lastRun.id}` : "—")}</strong></span><span><small>Heartbeat</small><strong id="kanbanHeartbeat">${task.last_heartbeat_at ? `${age(task.last_heartbeat_at)} ago` : "—"}</strong></span><span><small>Workspace</small><strong>${esc(task.workspace_kind || "scratch")}</strong></span></div>
        <div class="kanban-detail-controls">
          <div class="field"><label class="label">Assignee</label><select class="select" id="kanbanDetailAssignee">${profileOptions(task.assignee)}</select></div>
          <div class="field"><label class="label">Priority</label><select class="select" id="kanbanDetailPriority">${[0, 1, 2, 3].map((value) => `<option value="${value}"${Number(task.priority) === value ? " selected" : ""}>${priorityLabel(value)}</option>`).join("")}</select></div>
        </div>
        <div class="kanban-detail-actions">
          ${task.status === "triage" ? `<button class="btn btn-secondary sm" id="kanbanDecompose">${icon("branch")}Decompose</button>` : ""}
          ${!["ready", "running", "review", "done", "archived"].includes(task.status) ? `<button class="btn btn-primary sm" id="kanbanStart">${icon("play")}Move to Ready</button>` : ""}
          ${!["done", "archived"].includes(task.status) ? `<button class="btn btn-ghost sm" id="kanbanBlock">${icon("alert")}Block</button><button class="btn btn-ghost sm" id="kanbanDone">${icon("check")}Mark done</button>` : ""}
        </div>
        <nav class="kanban-detail-tabs"><button type="button" class="active" data-detail-tab="overview">Overview</button><button type="button" data-detail-tab="runs">Runs <small>${(data.runs || []).length}</small></button><button type="button" data-detail-tab="files">Files <small>${(data.attachments || []).length}</small></button><button type="button" data-detail-tab="activity">Activity <small>${(data.comments || []).length + (data.events || []).length}</small></button></nav>
        <div class="kanban-detail-panel" id="kanbanDetailPanel"></div><input type="file" id="kanbanDetailFiles" multiple hidden/>`,
      footer: `<button class="btn btn-ghost" id="kanbanArchive">${icon("trash")}Archive</button><div class="spacer"></div><button class="btn btn-secondary" data-close>Close</button>`,
      onMount: (modal) => {
        const panel = modal.querySelector("#kanbanDetailPanel");
        const fileInput = modal.querySelector("#kanbanDetailFiles");
        const renderPanel = () => {
          panel.innerHTML = activeTab === "runs" ? taskRuns(data, log) : activeTab === "files" ? taskFiles(data) : activeTab === "activity" ? taskActivityPanel(data) : taskOverview(data);
          modal.querySelectorAll("[data-detail-tab]").forEach((button) => button.classList.toggle("active", button.dataset.detailTab === activeTab));
          modal.querySelector('[data-detail-tab="runs"] small').textContent = (data.runs || []).length;
          modal.querySelector('[data-detail-tab="files"] small').textContent = (data.attachments || []).length;
          modal.querySelector('[data-detail-tab="activity"] small').textContent = (data.comments || []).length + (data.events || []).length;
        };
        const refresh = async ({ quiet = false, refreshLog = activeTab === "runs" } = {}) => {
          try {
            const [next, nextLog] = await Promise.all([api.kanban.task(id), refreshLog ? api.kanban.taskLog(id).catch(() => log) : Promise.resolve(log)]);
            data = next;
            log = nextLog;
            const current = data.task;
            modal.querySelector("#kanbanDetailStatus").textContent = current.status;
            modal.querySelector("#kanbanDetailLive").innerHTML = current.status === "running" ? `<i></i>Live · ${duration(current.started_at)}` : `${icon("clock")}${duration(current.started_at, current.completed_at)}`;
            modal.querySelector("#kanbanHeartbeat").textContent = current.last_heartbeat_at ? `${age(current.last_heartbeat_at)} ago` : "—";
            renderPanel();
          } catch (error) { if (!quiet) toast("error", "Task refresh failed", error.message); }
        };
        const update = async (patch, message) => {
          try {
            await api.kanban.updateTask(id, patch);
            if (patch.status === "ready") await api.kanban.dispatch().catch(() => {});
            toast("success", message);
            await Promise.all([refresh({ refreshLog: false }), loadBoard({ quiet: true })]);
          } catch (error) { toast("error", "Kanban update failed", error.message); }
        };
        modal.querySelectorAll("[data-detail-tab]").forEach((button) => {
          button.onclick = async () => { activeTab = button.dataset.detailTab; renderPanel(); if (activeTab === "runs" && !log) await refresh({ refreshLog: true }); };
        });
        modal.querySelector("#kanbanDetailAssignee").onchange = (event) => update({ assignee: event.target.value }, `Assigned to ${profileMeta(event.target.value).label}`);
        modal.querySelector("#kanbanDetailPriority").onchange = (event) => update({ priority: Number(event.target.value) }, "Priority updated");
        modal.querySelector("#kanbanStart")?.addEventListener("click", () => update({ status: "ready" }, "Task moved to Ready"));
        modal.querySelector("#kanbanDecompose")?.addEventListener("click", async () => {
          try { await api.kanban.decompose(id); toast("success", "Hermes decomposed the task"); await Promise.all([refresh({ refreshLog: false }), loadBoard({ quiet: true })]); }
          catch (error) { toast("error", "Decomposition failed", error.message); }
        });
        modal.querySelector("#kanbanBlock")?.addEventListener("click", () => openBlockTask(id));
        modal.querySelector("#kanbanDone")?.addEventListener("click", () => moveTask(id, "done"));
        modal.querySelector("#kanbanArchive").onclick = () => moveTask(id, "archived");
        panel.onclick = async (event) => {
          const child = event.target.closest("[data-child-task]");
          if (child) { closeOverlay(); return openTask(child.dataset.childTask); }
          if (event.target.closest("[data-upload]")) return fileInput.click();
          const download = event.target.closest("[data-download]");
          if (download) {
            const attachment = (data.attachments || []).find((item) => String(item.id) === download.dataset.download);
            if (!attachment) return;
            try {
              const result = await api.kanban.downloadAttachment(attachment.id);
              const url = URL.createObjectURL(result.blob);
              const link = document.createElement("a");
              link.href = url; link.download = attachment.filename; document.body.appendChild(link); link.click(); link.remove();
              setTimeout(() => URL.revokeObjectURL(url), 10000);
            } catch (error) { toast("error", "Download failed", error.message); }
            return;
          }
          const remove = event.target.closest("[data-remove]");
          if (remove) {
            if (remove.dataset.confirm !== "true") {
              remove.dataset.confirm = "true";
              remove.classList.add("danger");
              remove.setAttribute("data-tip", "Click again to confirm");
              return;
            }
            try { await api.kanban.deleteAttachment(remove.dataset.remove); toast("success", "File removed"); await refresh({ refreshLog: false }); }
            catch (error) { toast("error", "Could not remove file", error.message); }
            return;
          }
          if (event.target.closest("[data-log-refresh]")) return refresh({ refreshLog: true });
          if (event.target.closest("[data-comment]")) {
            const body = panel.querySelector("#kanbanComment")?.value.trim();
            if (!body) return;
            try { await api.kanban.comment(id, { body }); toast("success", "Comment added"); await refresh({ refreshLog: false }); }
            catch (error) { toast("error", "Comment failed", error.message); }
          }
        };
        fileInput.onchange = async () => {
          const files = [...fileInput.files];
          if (!files.length) return;
          if (files.some((file) => file.size > 25 * 1024 * 1024)) return toast("error", "File too large", "Kanban attachments are limited to 25 MB each");
          try {
            for (const file of files) await api.kanban.uploadAttachment(id, file);
            toast("success", `${files.length} file${files.length === 1 ? "" : "s"} uploaded`);
            fileInput.value = "";
            await refresh({ refreshLog: false });
          } catch (error) { toast("error", "Upload failed", error.message); }
        };
        renderPanel();
        if (task.status === "running") refresh({ quiet: true, refreshLog: true });
        const detailTimer = setInterval(() => {
          if (!modal.isConnected) return clearInterval(detailTimer);
          if (data.task.status === "running") refresh({ quiet: true, refreshLog: activeTab === "runs" });
        }, 3000);
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
