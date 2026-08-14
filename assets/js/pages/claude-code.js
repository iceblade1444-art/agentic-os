import { api } from "../api.js";
import { t } from "../i18n.js";
import { icon } from "../icons.js";
import { closeOverlay, esc, openModal, qs, toast } from "../ui.js";

let host = null;
let status = null;
let sessions = [];
let projects = [];
let projectState = null;
let profiles = [];
let active = null;
let filePath = "";
let attachments = [];
let taskStates = new Map();
let poll = null;

const ago = (stamp) => {
  if (!stamp) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - stamp) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};
const bytes = (size) => size == null ? "" : size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`;
const profileMeta = {
  default: ["Hermes", t("claude.role.default"), "brain"],
  scout: ["Scout", t("claude.role.scout"), "search"],
  scribe: ["Scribe", t("claude.role.scribe"), "edit"],
  reach: ["Reach", t("claude.role.reach"), "up"],
  dev: ["Dev", t("claude.role.dev"), "code"],
};

function selectedProject() {
  const workdir = qs("#claudeProject", host)?.value;
  return projects.find((item) => item.workdir === workdir) || null;
}

function projectOptions(selected) {
  return projects.map((item) => `<option value="${esc(item.workdir)}"${item.workdir === selected ? " selected" : ""}>${esc(item.name)}</option>`).join("");
}

function drawProjectStatus() {
  const slot = qs("#claudeProjectMeta", host);
  const sync = qs("#claudeProjectSync", host);
  if (!slot || !sync) return;
  sync.disabled = !projectState?.git;
  if (!projectState?.git) {
    slot.innerHTML = `<span>${icon("layers")}Local workspace</span>`;
    return;
  }
  const change = projectState.dirty ? t("claude.changes", { count: projectState.changes }) : t("claude.clean");
  const movement = [projectState.ahead ? `↑${projectState.ahead}` : "", projectState.behind ? `↓${projectState.behind}` : ""].filter(Boolean).join(" ");
  slot.innerHTML = `<span>${icon("branch")}${esc(projectState.branch)}</span><span class="${projectState.dirty ? "dirty" : "clean"}">${esc(change)}</span>${movement ? `<span>${esc(movement)}</span>` : ""}${projectState.remote ? `<a href="${esc(projectState.remote)}" target="_blank" rel="noopener" title="${t("claude.openOnGitHub")}">${icon("external")}</a>` : ""}`;
}

async function refreshProjectStatus(workdir = selectedProject()?.workdir) {
  const project = projects.find((item) => item.workdir === workdir);
  projectState = null;
  if (!project?.git) return drawProjectStatus();
  try { projectState = await api.claude.projectStatus(project.workdir); }
  catch (error) { toast("error", t("claude.gitUnavailable"), error.message); }
  drawProjectStatus();
}

async function refreshProjects(selected) {
  const result = await api.claude.projects();
  projects = result.projects || [];
  const value = projects.some((item) => item.workdir === selected) ? selected : status?.workRoot;
  qs("#claudeProject", host).innerHTML = projectOptions(value);
  qs("#claudeProject", host).value = value;
  await refreshProjectStatus(value);
}

function openProjectImport() {
  openModal({
    title: t("claude.importTitle"), width: 560,
    body: `<div class="field"><label class="label" for="claudeRepoUrl">${t("claude.repository")}</label><input class="input" id="claudeRepoUrl" placeholder="owner/repository or https://github.com/owner/repository" autocomplete="off"/></div>
      <div class="claude-import-grid"><div class="field"><label class="label" for="claudeRepoBranch">${t("claude.branch")}</label><input class="input" id="claudeRepoBranch" placeholder="${t("claude.defaultBranch")}" autocomplete="off"/></div><div class="field"><label class="label" for="claudeRepoFolder">${t("claude.folder")}</label><input class="input" id="claudeRepoFolder" placeholder="${t("claude.repoName")}" autocomplete="off"/></div></div>`,
    footer: `<button class="btn btn-secondary" data-close>${t("mila.cancel")}</button><button class="btn btn-primary" id="claudeImportProject">${icon("branch")}${t("claude.import")}</button>`,
    onMount: (modal) => {
      const url = modal.querySelector("#claudeRepoUrl");
      url.focus();
      modal.querySelector("#claudeImportProject").onclick = async () => {
        if (!url.value.trim()) return toast("error", t("claude.repoRequired"));
        const button = modal.querySelector("#claudeImportProject");
        button.classList.add("loading");
        try {
          const result = await api.claude.importProject({
            url: url.value.trim(),
            branch: modal.querySelector("#claudeRepoBranch").value.trim(),
            folder: modal.querySelector("#claudeRepoFolder").value.trim(),
          });
          closeOverlay();
          await refreshProjects(result.project.workdir);
          const session = await api.claude.createSession({ title: `${result.project.name} workspace`, workdir: result.project.workdir });
          sessions.unshift(session);
          await selectSession(session.id);
          toast("success", t("claude.imported"), t("claude.importedHint", { branch: result.project.branch }));
        } catch (error) { toast("error", t("claude.importFailed"), error.message); }
        finally { button.classList.remove("loading"); }
      };
    },
  });
}

async function syncSelectedProject() {
  const project = selectedProject();
  if (!project?.git) return;
  const button = qs("#claudeProjectSync", host);
  button.classList.add("loading");
  try {
    const result = await api.claude.syncProject(project.workdir);
    projectState = result.project;
    drawProjectStatus();
    if (active?.workdir === project.workdir) drawFiles();
    toast("success", t("claude.synced"), t("claude.syncedHint", { branch: result.project.branch }));
  } catch (error) { toast("error", t("claude.syncStopped"), error.message); }
  finally { button.classList.remove("loading"); }
}

function sessionRows() {
  const query = qs("#claudeSessionSearch", host)?.value?.trim().toLowerCase() || "";
  const visible = sessions.filter((item) => !query || `${item.title} ${item.lastMessage}`.toLowerCase().includes(query));
  return visible.length ? visible.map((item) => `
    <button class="claude-session ${active?.id === item.id ? "active" : ""}" data-session="${esc(item.id)}">
      <span class="claude-session-icon">${icon(item.status === "running" ? "activity" : "chat")}</span>
      <span><strong>${esc(item.title)}</strong><small>${esc(item.lastMessage || t("claude.noMessages"))}</small></span>
      <time>${ago(item.updatedAt)}</time>
    </button>`).join("") : `<div class="claude-side-empty">${t("claude.noSessions")}</div>`;
}

function drawSessions() {
  const slot = qs("#claudeSessions", host);
  if (!slot) return;
  slot.innerHTML = sessionRows();
  slot.querySelectorAll("[data-session]").forEach((button) => {
    button.onclick = () => selectSession(button.dataset.session);
  });
}

function drawHeader() {
  qs("#claudeTitle", host).textContent = active?.title || t("claude.workspace");
  qs("#claudeWorkdir", host).textContent = active?.workdir?.replace(status?.workRoot || "", "workspace") || t("claude.selectSession");
  const runtime = qs("#claudeRuntime", host);
  runtime.className = `claude-runtime ${status?.ready ? "ready" : "offline"}`;
  const activeModel = status?.model?.resolved || status?.defaultModel || "Claude";
  runtime.title = status?.error || `${status?.version || "Claude Code"} · ${activeModel}`;
  runtime.innerHTML = `<span></span>${status?.ready ? `${t("mila.phase.idle")} · ${esc(activeModel)}` : t("claude.unavailable")}`;
  qs("#claudeDelete", host).disabled = !active || active.status === "running";
}

function messageHTML(message) {
  const identity = message.role === "user" ? t("claude.you") : message.role === "agent" ? (profileMeta[message.agent]?.[0] || message.agent) : "Claude";
  const symbol = message.role === "user" ? "user" : message.role === "agent" ? (profileMeta[message.agent]?.[2] || "agents") : "sparkles";
  const files = (message.attachments || []).map((item) => `<span class="claude-message-file">${icon("file")}<span>${esc(item.name)}</span></span>`).join("");
  return `<article class="claude-message ${esc(message.role)}">
    <div class="claude-message-avatar">${icon(symbol)}</div>
    <div class="claude-message-body">
      <header><strong>${esc(identity)}</strong><time>${new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header>
      <div class="claude-message-text">${esc(message.text)}</div>
      ${files ? `<div class="claude-message-files">${files}</div>` : ""}
      ${message.meta ? `<footer>${message.meta.durationMs ? `${Math.round(message.meta.durationMs / 1000)}s` : ""}${message.meta.turns ? ` · ${message.meta.turns} turns` : ""}</footer>` : ""}
    </div>
  </article>`;
}

function drawConversation() {
  const slot = qs("#claudeConversation", host);
  if (!active) {
    slot.innerHTML = `<div class="claude-welcome"><span>${icon("code")}</span><h2>${t("claude.welcomeTitle")}</h2><p>${t("claude.welcomeHint")}</p><button class="btn btn-primary" id="claudeWelcomeNew">${icon("plus")}${t("claude.newSession")}</button></div>`;
    qs("#claudeWelcomeNew", slot).onclick = createSession;
    if (status?.error) slot.insertAdjacentHTML("afterbegin", runtimeAlert());
    return;
  }
  slot.innerHTML = active.messages?.length ? active.messages.map(messageHTML).join("") : `<div class="claude-welcome compact"><span>${icon("sparkles")}</span><h2>${esc(active.title)}</h2><p>${t("claude.sessionHint")}</p></div>`;
  if (status?.error) slot.insertAdjacentHTML("afterbegin", runtimeAlert());
  if (active.status === "running") slot.insertAdjacentHTML("beforeend", `<article class="claude-message assistant pending"><div class="claude-message-avatar">${icon("sparkles")}</div><div class="claude-message-body"><header><strong>Claude</strong></header><div class="claude-thinking"><i></i><i></i><i></i><span>${t("claude.working")}</span></div></div></article>`);
  requestAnimationFrame(() => { slot.scrollTop = slot.scrollHeight; });
  qs("#claudeSend", host).disabled = active.status === "running";
}

function runtimeAlert() {
  return `<div class="claude-runtime-alert">${icon("warn")}<span><strong>${t("claude.runtimeAttention")}</strong><small>${esc(status.error)}</small></span></div>`;
}

function drawAttachments() {
  const slot = qs("#claudeAttachments", host);
  slot.classList.toggle("active", attachments.length > 0);
  slot.innerHTML = attachments.map((item, index) => `<span class="claude-attachment">${icon("file")}<span><strong>${esc(item.name)}</strong><small>${bytes(item.size)}</small></span><button class="icon-btn" data-remove-attachment="${index}" title="${t("claude.remove")}">${icon("x")}</button></span>`).join("");
  slot.querySelectorAll("[data-remove-attachment]").forEach((button) => {
    button.onclick = () => { attachments.splice(Number(button.dataset.removeAttachment), 1); drawAttachments(); };
  });
}

async function drawFiles() {
  const slot = qs("#claudeSideBody", host);
  if (!active) { slot.innerHTML = `<div class="claude-side-empty">${t("claude.openToBrowse")}</div>`; return; }
  slot.innerHTML = `<div class="claude-loading"><span class="spinner"></span></div>`;
  try {
    const result = await api.claude.files(active.workdir, filePath);
    const parent = filePath ? `<button class="claude-file-row" data-folder="${esc(filePath.split("/").slice(0, -1).join("/"))}">${icon("chevleft")}<span><strong>${t("claude.back")}</strong><small>${esc(filePath)}</small></span></button>` : "";
    slot.innerHTML = `<div class="claude-file-path">${icon("layers")}<span>${esc(result.path || active.title)}</span></div>${parent}${result.entries.map((item) => `<button class="claude-file-row" ${item.type === "directory" ? `data-folder="${esc(item.path)}"` : `data-file="${esc(item.path)}"`}>
      ${icon(item.type === "directory" ? "layers" : "file")}<span><strong>${esc(item.name)}</strong><small>${item.type === "directory" ? t("claude.folderKind") : bytes(item.size)}</small></span>${item.type === "directory" ? icon("chevright") : ""}
    </button>`).join("") || `<div class="claude-side-empty">${t("claude.folderEmpty")}</div>`}`;
    slot.querySelectorAll("[data-folder]").forEach((button) => { button.onclick = () => { filePath = button.dataset.folder; drawFiles(); }; });
    slot.querySelectorAll("[data-file]").forEach((button) => { button.onclick = () => previewFile(button.dataset.file); });
  } catch (error) {
    slot.innerHTML = `<div class="claude-side-empty error">${esc(error.message)}</div>`;
  }
}

async function previewFile(relative) {
  try {
    const file = await api.claude.file(active.workdir, relative);
    openModal({ title: relative, width: 900, body: `<div class="claude-file-preview"><pre>${esc(file.content)}</pre></div>` });
  } catch (error) { toast("error", t("claude.previewFailed"), error.message); }
}

function drawAgents() {
  const slot = qs("#claudeSideBody", host);
  slot.innerHTML = `<div class="claude-agents-intro"><strong>${t("claude.delegateTitle")}</strong><p>${t("claude.delegateHint")}</p></div>${profiles.map((profile) => {
    const meta = profileMeta[profile.name] || [profile.name, t("claude.specialist"), "agents"];
    return `<button class="claude-agent-row" data-delegate="${esc(profile.name)}"><span>${icon(meta[2])}</span><span><strong>${esc(meta[0])}</strong><small>${esc(meta[1])}</small></span>${icon("arrowright")}</button>`;
  }).join("")}`;
  slot.querySelectorAll("[data-delegate]").forEach((button) => { button.onclick = () => delegate(button.dataset.delegate); });
}

function drawContext() {
  const slot = qs("#claudeSideBody", host);
  const items = active?.context || [];
  slot.innerHTML = items.length ? items.map((item) => `<div class="claude-context-row">${icon("file")}<span><strong>${esc(item.name)}</strong><small>${esc(item.path)} · ${bytes(item.size)}</small></span></div>`).join("") : `<div class="claude-side-empty">${t("claude.contextEmpty")}</div>`;
}

function drawLinkedTasks() {
  const slot = qs("#claudeProgress", host);
  const links = active?.linkedTasks || [];
  const done = links.filter((item) => ["done", "archived"].includes(taskStates.get(item.id)?.status)).length;
  qs("#claudeProgressCount", host).textContent = t("claude.progressCount", { done, total: links.length });
  slot.innerHTML = links.length ? links.map((item) => {
    const task = taskStates.get(item.id);
    const state = task?.status || "queued";
    return `<a class="claude-progress-row" href="#/kanban/task/${esc(item.id)}"><span class="claude-task-state ${esc(state)}">${icon(["done", "archived"].includes(state) ? "check" : state === "running" ? "activity" : "clock")}</span><span><strong>${esc(item.title)}</strong><small>${esc(profileMeta[item.profile]?.[0] || item.profile)} · ${esc(state)}</small></span></a>`;
  }).join("") : `<div class="claude-side-empty">${t("claude.noDelegated")}</div>`;
}

async function refreshTaskStates() {
  if (!active?.linkedTasks?.length) return drawLinkedTasks();
  await Promise.all(active.linkedTasks.map(async (link) => {
    try { const result = await api.kanban.task(link.id); taskStates.set(link.id, result.task || result); } catch {}
  }));
  drawLinkedTasks();
}

async function selectSession(id) {
  try {
    active = await api.claude.session(id);
    filePath = "";
    const picker = qs("#claudeProject", host);
    if ([...picker.options].some((option) => option.value === active.workdir)) picker.value = active.workdir;
    await refreshProjectStatus(active.workdir);
    drawSessions(); drawHeader(); drawConversation(); drawAttachments(); drawLinkedTasks();
    await refreshTaskStates();
    const selected = host.querySelector(".claude-side-tab.active")?.dataset.side || "files";
    if (selected === "files") drawFiles(); else if (selected === "agents") drawAgents(); else drawContext();
  } catch (error) { toast("error", t("claude.sessionUnavailable"), error.message); }
}

async function createSession() {
  const project = qs("#claudeProject", host).value || status?.workRoot;
  try {
    const session = await api.claude.createSession({ title: t("claude.newTask"), workdir: project });
    sessions.unshift(session);
    await selectSession(session.id);
    qs("#claudeComposer", host).focus();
  } catch (error) { toast("error", t("claude.createFailed"), error.message); }
}

async function sendMessage() {
  if (!active) await createSession();
  const textarea = qs("#claudeComposer", host);
  const text = textarea.value.trim();
  if (!text || !active) return;
  const payload = {
    text,
    effort: qs("#claudeEffort", host).value,
    permissionMode: qs("#claudeMode", host).value,
    model: qs("#claudeModel", host).value,
    attachments: attachments.map(({ name, type, data }) => ({ name, type, data })),
  };
  textarea.value = "";
  attachments = [];
  active.messages.push({ id: `optimistic-${Date.now()}`, role: "user", text, at: Date.now() });
  active.status = "running";
  drawConversation(); drawAttachments(); drawHeader();
  try {
    active = await api.claude.message(active.id, payload);
    const index = sessions.findIndex((item) => item.id === active.id);
    if (index >= 0) sessions[index] = { ...sessions[index], ...active };
  } catch (error) {
    toast("error", t("claude.failed"), error.message);
    active = await api.claude.session(active.id).catch(() => active);
  }
  drawSessions(); drawHeader(); drawConversation(); drawContext();
}

async function delegate(profile) {
  if (!active) return toast("error", t("claude.openFirst"));
  const draft = qs("#claudeComposer", host).value.trim();
  const lastUser = [...(active.messages || [])].reverse().find((message) => message.role === "user")?.text || "";
  const body = draft || lastUser;
  if (!body) return toast("error", t("claude.describeFirst"));
  try {
    const result = await api.claude.delegate(active.id, { profile, body, title: `${active.title} · ${profile}` });
    active = result.session;
    toast("success", `Task sent to ${profileMeta[profile]?.[0] || profile}`);
    drawConversation(); drawLinkedTasks(); await refreshTaskStates();
  } catch (error) { toast("error", t("claude.delegationFailed"), error.message); }
}

async function load() {
  try {
    const [runtime, sessionResult, projectResult, profileResult] = await Promise.all([
      api.claude.status(true), api.claude.sessions(), api.claude.projects(),
      api.kanban.profiles().catch(() => ({ profiles: Object.keys(profileMeta).map((name) => ({ name })) })),
    ]);
    status = runtime;
    sessions = sessionResult.sessions || [];
    projects = projectResult.projects || [];
    profiles = profileResult.profiles || [];
    const initialProject = sessions[0]?.workdir || status.workRoot;
    qs("#claudeProject", host).innerHTML = projectOptions(initialProject);
    await refreshProjectStatus(initialProject);
    drawSessions(); drawHeader();
    if (sessions.length) await selectSession(sessions[0].id); else { drawConversation(); drawFiles(); drawLinkedTasks(); }
  } catch (error) {
    qs("#claudeConversation", host).innerHTML = `<div class="claude-welcome"><span>${icon("warn")}</span><h2>${t("claude.workspaceUnavailable")}</h2><p>${esc(error.message)}</p></div>`;
  }
}

function handleFiles(fileList) {
  const files = [...fileList].slice(0, 6);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > 700 * 1024) return toast("error", t("claude.attachTooBig"));
  Promise.all(files.map((file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, size: file.size, data: String(reader.result).split(",").pop() });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  }))).then((items) => { attachments.push(...items); drawAttachments(); }).catch(() => toast("error", t("claude.attachUnreadable")));
}

export default {
  title: "Claude Workspace",
  render: () => `<div class="claude-workspace">
    <aside class="claude-rail">
      <div class="claude-rail-head"><strong>${icon("code")}Claude</strong><button class="icon-btn" id="claudeNew" title="${t("claude.newSession")}">${icon("plus")}</button></div>
      <div class="claude-project-row"><label class="claude-project-select">${icon("layers")}<select id="claudeProject"><option>${t("claude.loadingProjects")}</option></select></label><button class="icon-btn" id="claudeProjectSync" title="${t("claude.syncProject")}" disabled>${icon("refresh")}</button><button class="icon-btn" id="claudeProjectImport" title="${t("claude.importTitle")}">${icon("plus")}</button></div>
      <div class="claude-project-meta" id="claudeProjectMeta"><span>${icon("layers")}Local workspace</span></div>
      <label class="claude-session-search">${icon("search")}<input id="claudeSessionSearch" placeholder="${t("claude.searchSessions")}"/></label>
      <div class="claude-session-label">${t("claude.recent")}</div><div class="claude-sessions" id="claudeSessions"></div>
      <a class="claude-kanban-link" href="#/kanban">${icon("workflow")}Open shared Kanban${icon("arrowright")}</a>
    </aside>
    <main class="claude-main">
      <header class="claude-main-head"><div><h1 id="claudeTitle">${t("claude.workspace")}</h1><span id="claudeWorkdir">${t("missions.loading")}</span></div><div class="claude-runtime" id="claudeRuntime"><span></span>${t("mila.phase.checking")}</div><button class="icon-btn" id="claudeRefresh" title="${t("claude.refresh")}">${icon("refresh")}</button><button class="icon-btn danger" id="claudeDelete" title="${t("claude.deleteSession")}" disabled>${icon("trash")}</button></header>
      <section class="claude-conversation" id="claudeConversation"></section>
      <footer class="claude-compose-wrap">
        <div class="claude-attachments" id="claudeAttachments"></div>
        <div class="claude-composer"><button class="icon-btn" id="claudeAttach" title="${t("claude.attachContext")}">${icon("attach")}</button><input id="claudeFileInput" type="file" multiple hidden/><textarea id="claudeComposer" rows="1" placeholder="${t("claude.composer")}"></textarea><select id="claudeMode" title="${t("claude.permissionMode")}"><option value="acceptEdits">${t("claude.modeEdit")}</option><option value="plan">${t("claude.modePlan")}</option></select><select id="claudeEffort" title="${t("claude.effort")}"><option value="medium">${t("claude.effortMedium")}</option><option value="high" selected>${t("claude.effortHigh")}</option><option value="max">${t("claude.effortMax")}</option></select><select id="claudeModel" title="${t("claude.model")}"><option value="sonnet" selected>Sonnet</option><option value="fable">Fable Extra</option><option value="opus">Opus</option><option value="haiku">Haiku</option></select><button class="claude-send" id="claudeSend" title="${t("mila.send")}">${icon("send")}</button></div>
      </footer>
    </main>
    <aside class="claude-inspector">
      <section class="claude-progress"><header><strong>${t("claude.progress")}</strong><span id="claudeProgressCount">${t("claude.progressCount", { done: 0, total: 0 })}</span></header><div id="claudeProgress"></div></section>
      <section class="claude-side-panel"><div class="claude-side-tabs"><button class="claude-side-tab active" data-side="files">${t("claude.tab.files")}</button><button class="claude-side-tab" data-side="agents">${t("claude.tab.agents")}</button><button class="claude-side-tab" data-side="context">${t("claude.tab.context")}</button></div><div class="claude-side-body" id="claudeSideBody"></div></section>
    </aside>
  </div>`,
  mount(root) {
    host = root;
    qs("#claudeNew", host).onclick = createSession;
    qs("#claudeProjectImport", host).onclick = openProjectImport;
    qs("#claudeProjectSync", host).onclick = syncSelectedProject;
    qs("#claudeProject", host).onchange = (event) => refreshProjectStatus(event.target.value);
    qs("#claudeRefresh", host).onclick = () => active ? selectSession(active.id) : load();
    qs("#claudeDelete", host).onclick = async () => {
      if (!active || !window.confirm(`Delete session “${active.title}”?`)) return;
      await api.claude.removeSession(active.id);
      sessions = sessions.filter((item) => item.id !== active.id); active = null;
      drawSessions(); drawHeader(); drawConversation(); drawFiles(); drawLinkedTasks();
    };
    qs("#claudeSessionSearch", host).oninput = drawSessions;
    qs("#claudeAttach", host).onclick = () => qs("#claudeFileInput", host).click();
    qs("#claudeFileInput", host).onchange = (event) => { handleFiles(event.target.files); event.target.value = ""; };
    qs("#claudeSend", host).onclick = sendMessage;
    qs("#claudeComposer", host).onkeydown = (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } };
    host.querySelectorAll("[data-side]").forEach((button) => { button.onclick = () => {
      host.querySelectorAll("[data-side]").forEach((item) => item.classList.toggle("active", item === button));
      if (button.dataset.side === "files") drawFiles(); else if (button.dataset.side === "agents") drawAgents(); else drawContext();
    }; });
    load();
    poll = setInterval(async () => {
      if (!active) return;
      if (active.status === "running") await selectSession(active.id);
      else await refreshTaskStates();
    }, 5000);
  },
  unmount() { clearInterval(poll); poll = null; host = null; active = null; projectState = null; attachments = []; },
};
