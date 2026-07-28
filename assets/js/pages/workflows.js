import { api } from "../api.js";
import { icon } from "../icons.js";
import { closeOverlay, confirmDialog, esc, openModal, toast } from "../ui.js";
import { t } from "../i18n.js";

const COLUMNS = [
  { id: "triage", icon: "inbox", tone: "neutral" },
  { id: "todo", icon: "list", tone: "neutral" },
  { id: "scheduled", icon: "clock", tone: "info" },
  { id: "ready", icon: "play", tone: "success" },
  { id: "running", icon: "activity", tone: "warning" },
  { id: "review", icon: "eye", tone: "info" },
  { id: "blocked", icon: "alert", tone: "error" },
  { id: "done", icon: "check", tone: "success" },
];

const PROFILE_META = {
  default: { label: "Hermes", role: "orchestrator", icon: "brain", color: "violet" },
  scout: { label: "Scout", role: "research", icon: "search", color: "teal" },
  scribe: { label: "Scribe", role: "writing", icon: "edit", color: "blue" },
  reach: { label: "Reach", role: "growth", icon: "up", color: "amber" },
  dev: { label: "Dev", role: "engineering", icon: "code", color: "green" },
};

let pageRoot = null;
let board = null;
let profiles = [];
let orchestration = null;
let pollTimer = null;
let loading = false;

const taskList = () => (board?.columns || []).flatMap((column) => column.tasks || []);
const column = (status) => board?.columns?.find((item) => item.name === status)?.tasks || [];
const profileMeta = (name) => {
  const meta = PROFILE_META[name] || { label: name || t("kanban.unassigned"), role: "specialist", icon: "bot", color: "violet" };
  return { ...meta, role: t(`kanban.role.${meta.role}`) };
};
const priorityLabel = (value) => t(`kanban.priority.${["normal", "high", "urgent", "critical"][Math.max(0, Math.min(3, Number(value) || 0))]}`);
const columnLabel = (status) => t(`kanban.status.${status}`);

function age(timestamp) {
  if (!timestamp) return t("kanban.now");
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
  const waiting = tasks.filter((task) => task.status === "blocked" && task.block_kind === "needs_input").length;
  const blocked = tasks.filter((task) => task.status === "blocked" && task.block_kind !== "needs_input").length;
  return {
    running,
    queued,
    waiting,
    blocked,
    label: t(running ? "kanban.agent.working" : blocked ? "kanban.status.blocked" : waiting ? "kanban.agent.waiting" : queued ? "kanban.agent.queued" : "kanban.status.ready"),
  };
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
      <span class="kanban-agent-state ${state.running ? "running" : state.blocked ? "blocked" : state.waiting ? "waiting" : ""}"><i></i>${state.label}</span>
      <span class="kanban-agent-count">${state.running ? t("kanban.count.running", { count: state.running }) : state.blocked ? t("kanban.count.blocked", { count: state.blocked }) : state.waiting ? t("kanban.count.waiting", { count: state.waiting }) : state.queued ? t("kanban.count.queued", { count: state.queued }) : profile.model || ""}</span>
    </button>`;
  }).join("");
  host.querySelectorAll("[data-profile]").forEach((button) => {
    button.onclick = () => openProfile(button.dataset.profile);
  });
}

function cardHTML(task) {
  const meta = profileMeta(task.assignee);
  const progress = task.progress?.total ? `<span>${t("kanban.children", { done: task.progress.done, total: task.progress.total })}</span>` : "";
  const warnings = task.warnings?.count ? `<span class="kanban-warning">${icon("warn")}${task.warnings.count}</span>` : "";
  return `<article class="kanban-card" draggable="true" data-task-id="${esc(task.id)}" tabindex="0">
    <div class="kanban-card-top"><code>${esc(task.id)}</code><span class="kanban-priority p${Number(task.priority) || 0}">${priorityLabel(task.priority)}</span></div>
    <h3>${esc(task.title)}</h3>
    ${task.latest_summary ? `<p>${esc(task.latest_summary)}</p>` : ""}
    ${task.status === "running" ? `<div class="kanban-card-live"><i></i><span>${t("kanban.run")} #${esc(task.current_run_id || t("kanban.active"))}</span><span>${duration(task.started_at)}</span></div>` : ""}
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
      <header><span class="kanban-column-icon ${item.tone}">${icon(item.icon)}</span><strong>${columnLabel(item.id)}</strong><span class="kanban-column-count">${tasks.length}</span><button class="icon-btn tip" data-add-status="${item.id}" data-tip="${t("kanban.newTask")}" aria-label="${t("kanban.newTaskIn", { status: columnLabel(item.id) })}">${icon("plus")}</button></header>
      <div class="kanban-column-body">${tasks.length ? tasks.map(cardHTML).join("") : `<div class="kanban-column-empty">${t("kanban.noTasks")}</div>`}</div>
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
  if (summary) {
    const blocked = column("blocked");
    const waiting = blocked.filter((task) => task.block_kind === "needs_input").length;
    const failed = blocked.length - waiting;
    summary.textContent = t("kanban.summary", { tasks: taskList().length, running: column("running").length })
      + (waiting ? ` · ${t("kanban.count.waiting", { count: waiting })}` : "")
      + (failed ? ` · ${t("kanban.count.blocked", { count: failed })}` : "");
  }
  const mode = pageRoot?.querySelector("#kanbanMode");
  if (mode && orchestration) {
    mode.className = `btn sm ${orchestration.auto_decompose ? "btn-primary" : "btn-secondary"}`;
    mode.innerHTML = `${icon("branch")}${t("kanban.autoPlan")} ${t(orchestration.auto_decompose ? "kanban.on" : "kanban.off")}`;
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
    if (!quiet) toast("error", t("kanban.unavailable"), error.message);
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
    title: t("kanban.newKanbanTask"), width: 620,
    body: `<div class="field"><label class="label" for="kanbanTaskTitle">${t("member.title")}</label><input class="input" id="kanbanTaskTitle" maxlength="240" placeholder="${t("kanban.titlePlaceholder")}"/></div>
      <div class="field"><label class="label" for="kanbanTaskBody">${t("kanban.definition")}</label><textarea class="textarea" id="kanbanTaskBody" rows="5" placeholder="${t("kanban.definitionPlaceholder")}"></textarea></div>
      <div class="kanban-form-grid">
        <div class="field"><label class="label" for="kanbanTaskStatus">${t("kanban.startIn")}</label><select class="select" id="kanbanTaskStatus">
          <option value="triage"${status === "triage" ? " selected" : ""}>${t("kanban.start.triage")}</option>
          <option value="ready"${status === "ready" ? " selected" : ""}>${t("kanban.start.ready")}</option>
          <option value="todo"${status === "todo" ? " selected" : ""}>${t("kanban.start.todo")}</option>
        </select></div>
        <div class="field"><label class="label" for="kanbanTaskAssignee">${t("kanban.assignee")}</label><select class="select" id="kanbanTaskAssignee">${profileOptions(assignedProfile)}</select></div>
        <div class="field"><label class="label" for="kanbanTaskPriority">${t("member.priority")}</label><select class="select" id="kanbanTaskPriority">${[0,1,2,3].map((value) => `<option value="${value}">${priorityLabel(value)}</option>`).join("")}</select></div>
      </div>
      <div class="kanban-form-note" id="kanbanTaskNote">${t("kanban.note.triage")}</div>
      <div class="kanban-task-files"><input id="kanbanTaskFiles" type="file" multiple hidden/><button class="btn btn-secondary sm" id="kanbanSelectFiles" type="button">${icon("attach")}${t("kanban.attachFiles")}</button><span id="kanbanSelectedFiles">${t("kanban.noFilesSelected")}</span></div>`,
    footer: `<button class="btn btn-secondary" data-close>${t("system.cancel")}</button><button class="btn btn-primary" id="kanbanCreateTask">${icon("plus")}${t("member.createTask")}</button>`,
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
        fileSummary.textContent = selectedFiles.length ? `${t("kanban.fileCount", { count: selectedFiles.length })} · ${selectedFiles.map((file) => file.name).join(", ")}` : t("kanban.noFilesSelected");
        if (rejected) toast("error", t("kanban.fileTooLarge"), t("kanban.fileLimit"));
      };
      const syncMode = () => {
        const triage = statusInput.value === "triage";
        assignee.disabled = triage;
        if (triage) assignee.value = "default";
        note.textContent = triage
          ? t("kanban.note.triage")
          : statusInput.value === "ready" ? t("kanban.note.ready") : t("kanban.note.todo");
      };
      statusInput.onchange = syncMode;
      syncMode();
      modal.querySelector("#kanbanCreateTask").onclick = async () => {
        const title = modal.querySelector("#kanbanTaskTitle").value.trim();
        if (!title) return toast("error", t("kanban.titleRequired"));
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
            fileSummary.textContent = t("kanban.uploading", { count: selectedFiles.length });
            for (const file of selectedFiles) await api.kanban.uploadAttachment(taskId, file);
          }
          closeOverlay();
          toast("success", t("member.taskCreated"), t(statusInput.value === "triage" ? "kanban.hermesPlans" : "kanban.updated"));
          await api.kanban.dispatch().catch(() => {});
          await loadBoard();
        } catch (error) { toast("error", t("kanban.creationFailed"), error.message); }
        finally { button.classList.remove("loading"); }
      };
    },
  });
}

function taskActivity(data) {
  const items = [...(data.comments || []).map((item) => ({ ...item, kind: "comment" })), ...(data.events || [])]
    .sort((a, b) => Number(b.created_at || b.at || 0) - Number(a.created_at || a.at || 0)).slice(0, 40);
  if (!items.length) return `<div class="kanban-activity-empty">${t("kanban.noActivity")}</div>`;
  return items.map((item) => {
    const payload = item.payload || {};
    const message = item.body || item.message || payload.message || payload.summary
      || (payload.status ? `${t("kanban.statusLabel")} → ${columnLabel(payload.status)}` : Object.keys(payload).length ? JSON.stringify(payload) : t("kanban.statusUpdated"));
    return `<div class="kanban-activity-item"><span>${icon(item.kind === "comment" ? "chat" : "activity")}</span><div><strong>${esc(item.author || item.kind || "event")}</strong><p>${esc(message)}</p></div><time>${age(item.created_at || item.at)}</time></div>`;
  }).join("");
}

function taskOverview(data) {
  const task = data.task;
  const children = data.child_results || [];
  const completed = children.filter((child) => child.status === "done").length;
  const result = task.result || task.latest_summary;
  const diagnostics = task.diagnostics || [];
  return `${task.body ? `<section class="kanban-detail-section"><h4>${t("kanban.definition")}</h4><div class="kanban-detail-body">${esc(task.body)}</div></section>` : ""}
    ${task.block_reason ? `<section class="kanban-detail-section danger"><h4>${t("kanban.status.blocked")}</h4><p>${esc(task.block_reason)}</p></section>` : ""}
    ${result ? `<section class="kanban-result"><strong>${t(task.result ? "kanban.finalResult" : "kanban.latestHandoff")}</strong><p>${esc(result)}</p></section>` : task.status === "done" ? `<div class="kanban-detail-empty">${t("kanban.noFinalResult")}</div>` : ""}
    ${children.length ? `<section class="kanban-detail-section"><div class="kanban-section-head"><h4>${t("kanban.childResults")}</h4><span>${t("kanban.doneCount", { done: completed, total: children.length })}</span></div><div class="kanban-child-list">${children.map((child) => `<button type="button" data-child-task="${esc(child.id)}"><span><strong>${esc(child.title || child.id)}</strong><small>${esc(child.result || child.latest_summary || t("kanban.noResultYet"))}</small></span><i class="badge neutral">${esc(columnLabel(child.status))}</i>${icon("chevright")}</button>`).join("")}</div></section>` : ""}
    ${diagnostics.length ? `<section class="kanban-detail-section danger"><div class="kanban-section-head"><h4>${t("kanban.diagnostics")}</h4><span>${diagnostics.length}</span></div>${diagnostics.map((item) => `<p>${esc(item.message || item.summary || JSON.stringify(item))}</p>`).join("")}</section>` : ""}`;
}

function taskRuns(data, log) {
  const runs = [...(data.runs || [])].reverse();
  const history = runs.length ? runs.map((run) => {
    const state = run.ended_at ? run.outcome || run.status || "ended" : "active";
    const metadata = run.metadata && Object.keys(run.metadata).length ? `<details><summary>${t("kanban.metadata")}</summary><pre>${esc(JSON.stringify(run.metadata, null, 2))}</pre></details>` : "";
    return `<article class="kanban-run ${run.ended_at ? "" : "active"}"><header><span class="badge ${state === "completed" || state === "done" ? "success" : state === "active" ? "warning" : "neutral"}">${esc(state)}</span><strong>@${esc(run.profile || "default")}</strong><code>#${esc(run.id)}</code><time>${duration(run.started_at, run.ended_at)}</time></header>${run.summary ? `<p>${esc(run.summary)}</p>` : ""}${run.error ? `<p class="error-text">${esc(run.error)}</p>` : ""}${metadata}</article>`;
  }).join("") : `<div class="kanban-detail-empty">${t("kanban.noRuns")}</div>`;
  const logBody = !log ? `<div class="kanban-detail-empty">${t("kanban.loadingLog")}</div>` : log.exists
    ? `<pre class="kanban-worker-log">${esc(log.content || t("kanban.emptyLog"))}</pre>${log.truncated ? `<small>${t("kanban.logTruncated")}</small>` : ""}`
    : `<div class="kanban-detail-empty">${t("kanban.noLog")}</div>`;
  return `<section class="kanban-detail-section"><div class="kanban-section-head"><h4>${t("kanban.runHistory")}</h4><span>${runs.length}</span></div><div class="kanban-run-list">${history}</div></section>
    <section class="kanban-detail-section"><div class="kanban-section-head"><h4>${t("kanban.workerLog")}</h4><button type="button" class="btn btn-ghost sm" data-log-refresh>${icon("refresh")}${t("kanban.refresh")}</button></div>${logBody}</section>`;
}

function taskFiles(data) {
  const attachments = data.attachments || [];
  return `<section class="kanban-detail-section"><div class="kanban-section-head"><div><h4>${t("kanban.taskFiles")}</h4><small>${t("kanban.filesAvailable")}</small></div><button type="button" class="btn btn-secondary sm" data-upload>${icon("attach")}${t("kanban.upload")}</button></div>
    <div class="kanban-file-list">${attachments.length ? attachments.map((file) => `<div class="kanban-file-row"><span>${icon(file.content_type?.startsWith("image/") ? "image" : "file")}</span><div><strong>${esc(file.filename)}</strong><small>${bytes(file.size)} · ${esc(file.uploaded_by || "Agentic OS")} · ${age(file.created_at)}</small></div><button type="button" class="icon-btn tip" data-download="${esc(file.id)}" data-tip="${t("kanban.download")}" aria-label="${t("kanban.downloadFile", { name: esc(file.filename) })}">${icon("download")}</button><button type="button" class="icon-btn tip" data-remove="${esc(file.id)}" data-tip="${t("kanban.remove")}" aria-label="${t("kanban.removeFile", { name: esc(file.filename) })}">${icon("trash")}</button></div>`).join("") : `<div class="kanban-detail-empty">${t("kanban.noFiles")}</div>`}</div></section>`;
}

function taskActivityPanel(data) {
  return `<section class="kanban-activity"><div class="kanban-section-head"><h4>${t("kanban.activity")}</h4><span>${(data.comments || []).length + (data.events || []).length}</span></div>${taskActivity(data)}</section>
    <div class="kanban-comment"><textarea class="textarea" id="kanbanComment" rows="2" placeholder="${t("kanban.commentPlaceholder")}"></textarea><button class="btn btn-secondary" data-comment>${icon("send")}${t("kanban.comment")}</button></div>`;
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
      body: `<div class="kanban-detail-meta"><code>${esc(task.id)}</code><span class="badge neutral" id="kanbanDetailStatus">${esc(columnLabel(task.status))}</span><span class="kanban-priority p${Number(task.priority) || 0}">${priorityLabel(task.priority)}</span><span class="kanban-detail-live" id="kanbanDetailLive">${task.status === "running" ? `<i></i>${t("kanban.live")} · ${duration(task.started_at)}` : `${icon("clock")}${duration(task.started_at, task.completed_at)}`}</span></div>
        <div class="kanban-detail-stats"><span><small>${t("kanban.agent")}</small><strong>${esc(meta.label)}</strong></span><span><small>${t("kanban.run")}</small><strong>${esc(task.current_run_id ? `#${task.current_run_id}` : lastRun?.id ? `#${lastRun.id}` : "—")}</strong></span><span><small>${t("kanban.heartbeat")}</small><strong id="kanbanHeartbeat">${task.last_heartbeat_at ? t("kanban.ago", { value: age(task.last_heartbeat_at) }) : "—"}</strong></span><span><small>${t("kanban.workspace")}</small><strong>${esc(task.workspace_kind || "scratch")}</strong></span></div>
        <div class="kanban-detail-controls">
          <div class="field"><label class="label">${t("kanban.assignee")}</label><select class="select" id="kanbanDetailAssignee">${profileOptions(task.assignee)}</select></div>
          <div class="field"><label class="label">${t("kanban.priorityLabel")}</label><select class="select" id="kanbanDetailPriority">${[0, 1, 2, 3].map((value) => `<option value="${value}"${Number(task.priority) === value ? " selected" : ""}>${priorityLabel(value)}</option>`).join("")}</select></div>
        </div>
        <div class="kanban-detail-actions">
          ${task.status === "triage" ? `<button class="btn btn-secondary sm" id="kanbanDecompose">${icon("branch")}${t("kanban.decompose")}</button>` : ""}
          ${!["ready", "running", "review", "done", "archived"].includes(task.status) ? `<button class="btn btn-primary sm" id="kanbanStart">${icon("play")}${t("kanban.moveReady")}</button>` : ""}
          ${!["done", "archived"].includes(task.status) ? `<button class="btn btn-ghost sm" id="kanbanBlock">${icon("alert")}${t("kanban.block")}</button><button class="btn btn-ghost sm" id="kanbanDone">${icon("check")}${t("kanban.markDone")}</button>` : ""}
        </div>
        <nav class="kanban-detail-tabs"><button type="button" class="active" data-detail-tab="overview">${t("kanban.overview")}</button><button type="button" data-detail-tab="runs">${t("kanban.runs")} <small>${(data.runs || []).length}</small></button><button type="button" data-detail-tab="files">${t("kanban.files")} <small>${(data.attachments || []).length}</small></button><button type="button" data-detail-tab="activity">${t("kanban.activity")} <small>${(data.comments || []).length + (data.events || []).length}</small></button></nav>
        <div class="kanban-detail-panel" id="kanbanDetailPanel"></div><input type="file" id="kanbanDetailFiles" multiple hidden/>`,
      footer: `<button class="btn btn-ghost" id="kanbanArchive">${icon("trash")}${t("kanban.archive")}</button><div class="spacer"></div><button class="btn btn-secondary" data-close>${t("kanban.close")}</button>`,
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
            modal.querySelector("#kanbanDetailStatus").textContent = columnLabel(current.status);
            modal.querySelector("#kanbanDetailLive").innerHTML = current.status === "running" ? `<i></i>${t("kanban.live")} · ${duration(current.started_at)}` : `${icon("clock")}${duration(current.started_at, current.completed_at)}`;
            modal.querySelector("#kanbanHeartbeat").textContent = current.last_heartbeat_at ? t("kanban.ago", { value: age(current.last_heartbeat_at) }) : "—";
            renderPanel();
          } catch (error) { if (!quiet) toast("error", t("kanban.refreshFailed"), error.message); }
        };
        const update = async (patch, message) => {
          try {
            await api.kanban.updateTask(id, patch);
            if (patch.status === "ready") await api.kanban.dispatch().catch(() => {});
            toast("success", message);
            await Promise.all([refresh({ refreshLog: false }), loadBoard({ quiet: true })]);
          } catch (error) { toast("error", t("kanban.updateFailed"), error.message); }
        };
        modal.querySelectorAll("[data-detail-tab]").forEach((button) => {
          button.onclick = async () => { activeTab = button.dataset.detailTab; renderPanel(); if (activeTab === "runs" && !log) await refresh({ refreshLog: true }); };
        });
        modal.querySelector("#kanbanDetailAssignee").onchange = (event) => update({ assignee: event.target.value }, t("kanban.assignedTo", { name: profileMeta(event.target.value).label }));
        modal.querySelector("#kanbanDetailPriority").onchange = (event) => update({ priority: Number(event.target.value) }, t("kanban.priorityUpdated"));
        modal.querySelector("#kanbanStart")?.addEventListener("click", () => update({ status: "ready" }, t("kanban.movedReady")));
        modal.querySelector("#kanbanDecompose")?.addEventListener("click", async () => {
          try { await api.kanban.decompose(id); toast("success", t("kanban.decomposed")); await Promise.all([refresh({ refreshLog: false }), loadBoard({ quiet: true })]); }
          catch (error) { toast("error", t("kanban.decomposeFailed"), error.message); }
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
            } catch (error) { toast("error", t("kanban.downloadFailed"), error.message); }
            return;
          }
          const remove = event.target.closest("[data-remove]");
          if (remove) {
            if (remove.dataset.confirm !== "true") {
              remove.dataset.confirm = "true";
              remove.classList.add("danger");
              remove.setAttribute("data-tip", t("kanban.clickConfirm"));
              return;
            }
            try { await api.kanban.deleteAttachment(remove.dataset.remove); toast("success", t("kanban.fileRemoved")); await refresh({ refreshLog: false }); }
            catch (error) { toast("error", t("kanban.removeFailed"), error.message); }
            return;
          }
          if (event.target.closest("[data-log-refresh]")) return refresh({ refreshLog: true });
          if (event.target.closest("[data-comment]")) {
            const body = panel.querySelector("#kanbanComment")?.value.trim();
            if (!body) return;
            try { await api.kanban.comment(id, { body }); toast("success", t("kanban.commentAdded")); await refresh({ refreshLog: false }); }
            catch (error) { toast("error", t("kanban.commentFailed"), error.message); }
          }
        };
        fileInput.onchange = async () => {
          const files = [...fileInput.files];
          if (!files.length) return;
          if (files.some((file) => file.size > 25 * 1024 * 1024)) return toast("error", t("kanban.fileTooLarge"), t("kanban.fileLimit"));
          try {
            for (const file of files) await api.kanban.uploadAttachment(id, file);
            toast("success", t("kanban.filesUploaded", { count: files.length }));
            fileInput.value = "";
            await refresh({ refreshLog: false });
          } catch (error) { toast("error", t("kanban.uploadFailed"), error.message); }
        };
        renderPanel();
        if (task.status === "running") refresh({ quiet: true, refreshLog: true });
        const detailTimer = setInterval(() => {
          if (!modal.isConnected) return clearInterval(detailTimer);
          if (data.task.status === "running") refresh({ quiet: true, refreshLog: activeTab === "runs" });
        }, 3000);
      },
    });
  } catch (error) { toast("error", t("kanban.taskUnavailable"), error.message); }
}

function openProfile(name) {
  const profile = profiles.find((item) => item.name === name);
  if (!profile) return;
  const meta = profileMeta(name);
  const state = agentState(name);
  openModal({
    title: `${meta.label} · ${meta.role}`, width: 620,
    body: `<div class="kanban-profile-head"><span class="kanban-agent-icon ${meta.color}">${icon(meta.icon)}</span><div><strong>${esc(profile.model || t("kanban.configuredModel"))}</strong><span>${esc(profile.provider || t("kanban.hermesProfile"))}</span></div><span class="badge ${state.running ? "warning" : "success"}">${state.label}</span></div>
      <p class="kanban-profile-description">${esc(profile.description || t("kanban.noRouting"))}</p>
      <div class="kanban-profile-stats"><span><strong>${state.running}</strong>${t("kanban.status.running")}</span><span><strong>${state.queued}</strong>${t("kanban.agent.queued")}</span><span><strong>${state.blocked}</strong>${t("kanban.status.blocked")}</span><span><strong>${profile.skill_count || 0}</strong>${t("kanban.skills")}</span></div>`,
    footer: `<a class="btn btn-secondary" href="#/hermes" data-close>${icon("settings")}${t("kanban.hermesProfile")}</a><button class="btn btn-primary" id="kanbanAssignProfile">${icon("plus")}${t("kanban.assignTask")}</button>`,
    onMount: (modal) => {
      modal.querySelector("#kanbanAssignProfile").onclick = () => { closeOverlay(); openCreateTask("ready", name); };
    },
  });
}

function openBlockTask(id) {
  openModal({
    title: t("kanban.blockTask"), width: 520,
    body: `<div class="field"><label class="label" for="kanbanBlockReason">${t("kanban.blockQuestion")}</label><textarea class="textarea" id="kanbanBlockReason" rows="4" placeholder="${t("kanban.blockPlaceholder")}"></textarea></div>`,
    footer: `<button class="btn btn-secondary" data-close>${t("kanban.cancel")}</button><button class="btn btn-primary" id="kanbanConfirmBlock">${icon("alert")}${t("kanban.blockTask")}</button>`,
    onMount: (modal) => {
      modal.querySelector("#kanbanConfirmBlock").onclick = async () => {
        const reason = modal.querySelector("#kanbanBlockReason").value.trim();
        if (!reason) return toast("error", t("kanban.blockRequired"));
        try { await api.kanban.updateTask(id, { status: "blocked", block_reason: reason }); closeOverlay(); await loadBoard(); }
        catch (error) { toast("error", t("kanban.blockFailed"), error.message); }
      };
    },
  });
}

function moveTask(id, status) {
  const task = taskList().find((item) => item.id === id);
  if (!task || task.status === status) return;
  if (status === "running") return toast("info", t("kanban.runningAutomatic"), t("kanban.runningHint"));
  if (status === "blocked") return openBlockTask(id);
  const apply = async () => {
    try { await api.kanban.updateTask(id, { status }); closeOverlay(); toast("success", t("kanban.updated"), `${task.title} → ${columnLabel(status)}`); await loadBoard(); }
    catch (error) { toast("error", t("kanban.updateFailed"), error.message); }
  };
  if (["done", "archived"].includes(status)) {
    return confirmDialog({
      title: t(status === "done" ? "kanban.markDoneQuestion" : "kanban.archiveQuestion"),
      message: t(status === "done" ? "kanban.markDoneHint" : "kanban.archiveHint"),
      confirmText: t(status === "done" ? "kanban.markDone" : "kanban.archive"),
      onConfirm: apply,
    });
  }
  apply();
}

export default {
  title: t("kanban.title"),
  render: () => `<div class="kanban-page">
    <div class="page-head kanban-head"><div><div class="page-title">${t("kanban.hermesKanban")}</div><div class="page-sub" id="kanbanSummary">${t("kanban.loading")}</div></div><div class="spacer"></div>
      <button class="btn btn-secondary sm" id="kanbanMode">${icon("branch")}${t("kanban.autoPlan")}</button>
      <button class="icon-btn tip" id="kanbanRefresh" data-tip="${t("kanban.refresh")}" aria-label="${t("kanban.refreshAria")}">${icon("refresh")}</button>
      <button class="btn btn-primary" id="kanbanNew">${icon("plus")}${t("kanban.newTask")}</button>
    </div>
    <div class="kanban-fleet" id="kanbanFleet"><div class="skeleton" style="height:76px"></div></div>
    <div class="alert error hidden" id="kanbanError"><span>${t("kanban.unavailable")}</span></div>
    <div class="kanban-board" id="kanbanBoard">${COLUMNS.map((item) => `<section class="kanban-column"><header><strong>${columnLabel(item.id)}</strong></header><div class="kanban-column-body"><div class="skeleton" style="height:112px"></div></div></section>`).join("")}</div>
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
        toast("success", t(orchestration.auto_decompose ? "kanban.planningEnabled" : "kanban.planningDisabled"));
      } catch (error) { toast("error", t("kanban.orchestrationFailed"), error.message); }
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
