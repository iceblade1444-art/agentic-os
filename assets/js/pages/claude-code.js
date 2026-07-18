import { api } from "../api.js";
import { icon } from "../icons.js";
import { esc, openModal, qs, toast } from "../ui.js";

let host = null;
let status = null;
let sessions = [];
let projects = [];
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
  default: ["Hermes", "Orchestration", "brain"],
  scout: ["Scout", "Research", "search"],
  scribe: ["Scribe", "Writing", "edit"],
  reach: ["Reach", "Growth", "up"],
  dev: ["Dev", "Engineering", "code"],
};

function sessionRows() {
  const query = qs("#claudeSessionSearch", host)?.value?.trim().toLowerCase() || "";
  const visible = sessions.filter((item) => !query || `${item.title} ${item.lastMessage}`.toLowerCase().includes(query));
  return visible.length ? visible.map((item) => `
    <button class="claude-session ${active?.id === item.id ? "active" : ""}" data-session="${esc(item.id)}">
      <span class="claude-session-icon">${icon(item.status === "running" ? "activity" : "chat")}</span>
      <span><strong>${esc(item.title)}</strong><small>${esc(item.lastMessage || "No messages yet")}</small></span>
      <time>${ago(item.updatedAt)}</time>
    </button>`).join("") : `<div class="claude-side-empty">No sessions found</div>`;
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
  qs("#claudeTitle", host).textContent = active?.title || "Claude Workspace";
  qs("#claudeWorkdir", host).textContent = active?.workdir?.replace(status?.workRoot || "", "workspace") || "Select a session";
  const runtime = qs("#claudeRuntime", host);
  runtime.className = `claude-runtime ${status?.ready ? "ready" : "offline"}`;
  runtime.title = status?.error || status?.version || "Claude Code runtime";
  runtime.innerHTML = `<span></span>${status?.ready ? `Ready · ${esc(status.version || "Claude Code")}` : "Claude unavailable"}`;
  qs("#claudeDelete", host).disabled = !active || active.status === "running";
}

function messageHTML(message) {
  const identity = message.role === "user" ? "You" : message.role === "agent" ? (profileMeta[message.agent]?.[0] || message.agent) : "Claude";
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
    slot.innerHTML = `<div class="claude-welcome"><span>${icon("code")}</span><h2>Build with Claude Code</h2><p>Open a focused coding session, add project context, then bring Hermes specialists into the same task.</p><button class="btn btn-primary" id="claudeWelcomeNew">${icon("plus")}New session</button></div>`;
    qs("#claudeWelcomeNew", slot).onclick = createSession;
    if (status?.error) slot.insertAdjacentHTML("afterbegin", runtimeAlert());
    return;
  }
  slot.innerHTML = active.messages?.length ? active.messages.map(messageHTML).join("") : `<div class="claude-welcome compact"><span>${icon("sparkles")}</span><h2>${esc(active.title)}</h2><p>Describe what you want to inspect, build or fix. Claude works inside the selected project workspace.</p></div>`;
  if (status?.error) slot.insertAdjacentHTML("afterbegin", runtimeAlert());
  if (active.status === "running") slot.insertAdjacentHTML("beforeend", `<article class="claude-message assistant pending"><div class="claude-message-avatar">${icon("sparkles")}</div><div class="claude-message-body"><header><strong>Claude</strong></header><div class="claude-thinking"><i></i><i></i><i></i><span>Working in the project…</span></div></div></article>`);
  requestAnimationFrame(() => { slot.scrollTop = slot.scrollHeight; });
  qs("#claudeSend", host).disabled = active.status === "running";
}

function runtimeAlert() {
  return `<div class="claude-runtime-alert">${icon("warn")}<span><strong>Claude runtime needs attention</strong><small>${esc(status.error)}</small></span></div>`;
}

function drawAttachments() {
  const slot = qs("#claudeAttachments", host);
  slot.classList.toggle("active", attachments.length > 0);
  slot.innerHTML = attachments.map((item, index) => `<span class="claude-attachment">${icon("file")}<span><strong>${esc(item.name)}</strong><small>${bytes(item.size)}</small></span><button class="icon-btn" data-remove-attachment="${index}" title="Remove">${icon("x")}</button></span>`).join("");
  slot.querySelectorAll("[data-remove-attachment]").forEach((button) => {
    button.onclick = () => { attachments.splice(Number(button.dataset.removeAttachment), 1); drawAttachments(); };
  });
}

async function drawFiles() {
  const slot = qs("#claudeSideBody", host);
  if (!active) { slot.innerHTML = `<div class="claude-side-empty">Open a session to browse its project.</div>`; return; }
  slot.innerHTML = `<div class="claude-loading"><span class="spinner"></span></div>`;
  try {
    const result = await api.claude.files(active.workdir, filePath);
    const parent = filePath ? `<button class="claude-file-row" data-folder="${esc(filePath.split("/").slice(0, -1).join("/"))}">${icon("chevleft")}<span><strong>Back</strong><small>${esc(filePath)}</small></span></button>` : "";
    slot.innerHTML = `<div class="claude-file-path">${icon("layers")}<span>${esc(result.path || active.title)}</span></div>${parent}${result.entries.map((item) => `<button class="claude-file-row" ${item.type === "directory" ? `data-folder="${esc(item.path)}"` : `data-file="${esc(item.path)}"`}>
      ${icon(item.type === "directory" ? "layers" : "file")}<span><strong>${esc(item.name)}</strong><small>${item.type === "directory" ? "Folder" : bytes(item.size)}</small></span>${item.type === "directory" ? icon("chevright") : ""}
    </button>`).join("") || `<div class="claude-side-empty">This folder is empty.</div>`}`;
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
  } catch (error) { toast("error", "Cannot preview file", error.message); }
}

function drawAgents() {
  const slot = qs("#claudeSideBody", host);
  slot.innerHTML = `<div class="claude-agents-intro"><strong>Delegate with context</strong><p>Claude keeps the coding thread. Hermes agents receive a linked task in the shared Kanban.</p></div>${profiles.map((profile) => {
    const meta = profileMeta[profile.name] || [profile.name, "Specialist", "agents"];
    return `<button class="claude-agent-row" data-delegate="${esc(profile.name)}"><span>${icon(meta[2])}</span><span><strong>${esc(meta[0])}</strong><small>${esc(meta[1])}</small></span>${icon("arrowright")}</button>`;
  }).join("")}`;
  slot.querySelectorAll("[data-delegate]").forEach((button) => { button.onclick = () => delegate(button.dataset.delegate); });
}

function drawContext() {
  const slot = qs("#claudeSideBody", host);
  const items = active?.context || [];
  slot.innerHTML = items.length ? items.map((item) => `<div class="claude-context-row">${icon("file")}<span><strong>${esc(item.name)}</strong><small>${esc(item.path)} · ${bytes(item.size)}</small></span></div>`).join("") : `<div class="claude-side-empty">Attached files used by this session will appear here.</div>`;
}

function drawLinkedTasks() {
  const slot = qs("#claudeProgress", host);
  const links = active?.linkedTasks || [];
  const done = links.filter((item) => ["done", "archived"].includes(taskStates.get(item.id)?.status)).length;
  qs("#claudeProgressCount", host).textContent = `${done} of ${links.length}`;
  slot.innerHTML = links.length ? links.map((item) => {
    const task = taskStates.get(item.id);
    const state = task?.status || "queued";
    return `<a class="claude-progress-row" href="#/kanban/task/${esc(item.id)}"><span class="claude-task-state ${esc(state)}">${icon(["done", "archived"].includes(state) ? "check" : state === "running" ? "activity" : "clock")}</span><span><strong>${esc(item.title)}</strong><small>${esc(profileMeta[item.profile]?.[0] || item.profile)} · ${esc(state)}</small></span></a>`;
  }).join("") : `<div class="claude-side-empty">No delegated tasks yet.</div>`;
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
    drawSessions(); drawHeader(); drawConversation(); drawAttachments(); drawLinkedTasks();
    await refreshTaskStates();
    const selected = host.querySelector(".claude-side-tab.active")?.dataset.side || "files";
    if (selected === "files") drawFiles(); else if (selected === "agents") drawAgents(); else drawContext();
  } catch (error) { toast("error", "Session unavailable", error.message); }
}

async function createSession() {
  const project = qs("#claudeProject", host).value || status?.workRoot;
  try {
    const session = await api.claude.createSession({ title: "New coding task", workdir: project });
    sessions.unshift(session);
    await selectSession(session.id);
    qs("#claudeComposer", host).focus();
  } catch (error) { toast("error", "Could not create session", error.message); }
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
    toast("error", "Claude Code failed", error.message);
    active = await api.claude.session(active.id).catch(() => active);
  }
  drawSessions(); drawHeader(); drawConversation(); drawContext();
}

async function delegate(profile) {
  if (!active) return toast("error", "Open a Claude session first");
  const draft = qs("#claudeComposer", host).value.trim();
  const lastUser = [...(active.messages || [])].reverse().find((message) => message.role === "user")?.text || "";
  const body = draft || lastUser;
  if (!body) return toast("error", "Describe the task before delegating");
  try {
    const result = await api.claude.delegate(active.id, { profile, body, title: `${active.title} · ${profile}` });
    active = result.session;
    toast("success", `Task sent to ${profileMeta[profile]?.[0] || profile}`);
    drawConversation(); drawLinkedTasks(); await refreshTaskStates();
  } catch (error) { toast("error", "Delegation failed", error.message); }
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
    qs("#claudeProject", host).innerHTML = projects.map((item) => `<option value="${esc(item.workdir)}">${esc(item.name)}</option>`).join("");
    drawSessions(); drawHeader();
    if (sessions.length) await selectSession(sessions[0].id); else { drawConversation(); drawFiles(); drawLinkedTasks(); }
  } catch (error) {
    qs("#claudeConversation", host).innerHTML = `<div class="claude-welcome"><span>${icon("warn")}</span><h2>Claude Workspace unavailable</h2><p>${esc(error.message)}</p></div>`;
  }
}

function handleFiles(fileList) {
  const files = [...fileList].slice(0, 6);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > 700 * 1024) return toast("error", "Attachments exceed 700 KB");
  Promise.all(files.map((file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, size: file.size, data: String(reader.result).split(",").pop() });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  }))).then((items) => { attachments.push(...items); drawAttachments(); }).catch(() => toast("error", "Could not read attachment"));
}

export default {
  title: "Claude Workspace",
  render: () => `<div class="claude-workspace">
    <aside class="claude-rail">
      <div class="claude-rail-head"><strong>${icon("code")}Claude</strong><button class="icon-btn" id="claudeNew" title="New session">${icon("plus")}</button></div>
      <label class="claude-project-select">${icon("layers")}<select id="claudeProject"><option>Loading projects…</option></select></label>
      <label class="claude-session-search">${icon("search")}<input id="claudeSessionSearch" placeholder="Search sessions"/></label>
      <div class="claude-session-label">Recent</div><div class="claude-sessions" id="claudeSessions"></div>
      <a class="claude-kanban-link" href="#/kanban">${icon("workflow")}Open shared Kanban${icon("arrowright")}</a>
    </aside>
    <main class="claude-main">
      <header class="claude-main-head"><div><h1 id="claudeTitle">Claude Workspace</h1><span id="claudeWorkdir">Loading…</span></div><div class="claude-runtime" id="claudeRuntime"><span></span>Checking</div><button class="icon-btn" id="claudeRefresh" title="Refresh">${icon("refresh")}</button><button class="icon-btn danger" id="claudeDelete" title="Delete session" disabled>${icon("trash")}</button></header>
      <section class="claude-conversation" id="claudeConversation"></section>
      <footer class="claude-compose-wrap">
        <div class="claude-attachments" id="claudeAttachments"></div>
        <div class="claude-composer"><button class="icon-btn" id="claudeAttach" title="Attach context">${icon("attach")}</button><input id="claudeFileInput" type="file" multiple hidden/><textarea id="claudeComposer" rows="1" placeholder="Ask Claude to inspect, build or fix…"></textarea><select id="claudeMode" title="Permission mode"><option value="acceptEdits">Edit</option><option value="plan">Plan</option></select><select id="claudeEffort" title="Reasoning effort"><option value="medium">Medium</option><option value="high" selected>High</option><option value="max">Max</option></select><select id="claudeModel" title="Claude model"><option value="fable" selected>Fable</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option><option value="haiku">Haiku</option></select><button class="claude-send" id="claudeSend" title="Send">${icon("send")}</button></div>
      </footer>
    </main>
    <aside class="claude-inspector">
      <section class="claude-progress"><header><strong>Progress</strong><span id="claudeProgressCount">0 of 0</span></header><div id="claudeProgress"></div></section>
      <section class="claude-side-panel"><div class="claude-side-tabs"><button class="claude-side-tab active" data-side="files">Files</button><button class="claude-side-tab" data-side="agents">Agents</button><button class="claude-side-tab" data-side="context">Context</button></div><div class="claude-side-body" id="claudeSideBody"></div></section>
    </aside>
  </div>`,
  mount(root) {
    host = root;
    qs("#claudeNew", host).onclick = createSession;
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
  unmount() { clearInterval(poll); poll = null; host = null; active = null; attachments = []; },
};
