import { api } from "../api.js";
import { icon } from "../icons.js";
import { localizedDate, setLocale, t } from "../i18n.js";
import { milaHub } from "../mila-session.js";
import { esc, toast } from "../ui.js";

const tabs = [
  ["today", "home"],
  ["soul", "brain"],
  ["memory", "knowledge"],
  ["files", "file"],
  ["approvals", "guardrails"],
  ["account", "user"],
];

let data = null;
let activeTab = "today";

const stateLabel = (value) => t(value === "connected" ? "personal.status.connected" : value === "setup_required" ? "personal.status.setup" : "personal.status.disconnected");
const stateTone = (value) => value === "connected" ? "connected" : value === "setup_required" ? "warning" : "muted";
const shortDate = (value) => localizedDate(value);
const dueLabel = (value) => value ? localizedDate(`${value}T12:00:00`) : t("personal.noDue");

function briefingCopy() {
  const briefing = data.briefing;
  const firstName = briefing.firstName || String(data.account?.name || "").trim().split(/\s+/)[0];
  const greeting = `${t(`personal.greeting.${briefing.greetingPeriod || "day"}`)}, ${firstName}`;
  const summary = [
    briefing.focus ? t("personal.summary.focus", { title: briefing.focus.title }) : t("personal.summary.noTasks"),
    briefing.dueCount ? t("personal.summary.due", { count: briefing.dueCount }) : "",
    briefing.approvalCount ? t("personal.summary.approvals", { count: briefing.approvalCount }) : "",
  ].filter(Boolean).join(" ");
  return { greeting, summary };
}

function shell() {
  return `<div class="personal-page">
    <div class="page-head personal-heading">
      <div><p class="member-eyebrow">${t("personal.eyebrow")}</p><h1 class="page-title">${t("personal.title")}</h1><p class="page-sub">${t("personal.subtitle")}</p></div>
      <div class="spacer"></div>
      <a class="btn btn-secondary" href="#/chat">${icon("chat")}${t("personal.askMila")}</a>
      <button class="btn btn-primary" data-personal-new>${icon("plus")}${t("personal.newTask")}</button>
    </div>
    <nav class="personal-tabs" aria-label="${t("personal.tabs")}">
      ${tabs.map(([id, glyph]) => `<button type="button" data-personal-tab="${id}" class="${id === activeTab ? "active" : ""}">${icon(glyph)}<span>${t(`personal.tab.${id}`)}</span>${id === "approvals" && data?.briefing?.approvalCount ? `<b>${data.briefing.approvalCount}</b>` : ""}</button>`).join("")}
    </nav>
    <div id="personalContent">${content()}</div>
  </div>`;
}

function taskItem(task) {
  return `<article class="personal-task">
    <span class="member-priority ${esc(task.priority)}"></span>
    <div><strong>${esc(task.title)}</strong><small>${t(task.status === "doing" ? "personal.task.doing" : "personal.task.todo")} · ${esc(dueLabel(task.dueDate))}</small></div>
    <button class="icon-btn tip" data-personal-done="${esc(task.id)}" data-tip="${t("personal.task.doneTip")}" aria-label="${t("personal.task.doneAria")}">${icon("check")}</button>
  </article>`;
}

function approvalTitle(item) {
  return item?.title || item?.description || item?.action || item?.summary || item?.id || t("personal.approval.action");
}

function approvalItem(item, compact = false) {
  const id = item?.id || item?.approval_id || "";
  return `<article class="personal-approval ${compact ? "compact" : ""}">
    <span>${icon("guardrails")}</span>
    <div><strong>${esc(approvalTitle(item))}</strong><small>${esc(item?.agent || item?.actor || "Hermes")} · ${t("personal.approval.required")}</small></div>
    ${compact ? `<a href="#/personal/approvals" class="btn btn-ghost sm">${t("personal.open")}</a>` : `<div class="personal-approval-actions"><button class="btn btn-secondary sm" data-approval="${esc(id)}" data-decision="reject">${t("personal.reject")}</button><button class="btn btn-primary sm" data-approval="${esc(id)}" data-decision="approve">${t("personal.approve")}</button></div>`}
  </article>`;
}

function sourceRow(name, key, glyph, target = "") {
  const value = data.sources[key];
  const body = `<span class="personal-source-icon">${icon(glyph)}</span><span><strong>${name}</strong><small class="${stateTone(value)}">${stateLabel(value)}</small></span>${icon("chevright")}`;
  return target ? `<a class="personal-source" href="${target}">${body}</a>` : `<div class="personal-source disabled">${body}</div>`;
}

function googleSource(name, key, glyph) {
  const value = data.sources[key];
  const body = `<span class="personal-source-icon">${icon(glyph)}</span><span><strong>${name}</strong><small class="${stateTone(value)}">${stateLabel(value)}</small></span>${icon("chevright")}`;
  return `<button type="button" class="personal-source ${data.google?.configured ? "" : "disabled"}" data-google-connect ${data.google?.configured ? "" : "disabled"}>${body}</button>`;
}

function todayView() {
  const focus = data.briefing.focus;
  const briefing = briefingCopy();
  return `<section class="personal-today">
    <div class="personal-briefing">
      <div class="personal-briefing-icon">${icon("sparkles")}</div>
      <div><span>${t("personal.briefing")}</span><h2>${esc(briefing.greeting)}</h2><p>${esc(briefing.summary)}</p></div>
      <div class="personal-load"><strong>${data.briefing.load}%</strong><span>${t("personal.load")}</span><i><b style="width:${data.briefing.load}%"></b></i></div>
    </div>
    <form class="personal-capture" data-capture-form>
      ${icon("command")}<input maxlength="160" data-capture-input placeholder="${t("personal.capture")}"/>
      <button class="btn btn-primary" type="submit">${icon("plus")}${t("personal.add")}</button>
    </form>
    <div class="personal-today-grid">
      <section class="personal-panel personal-focus">
        <header><div><span>${t("personal.plan")}</span><h3>${t("personal.priorityTasks")}</h3></div><a href="#/my-tasks">${t("personal.allTasks")} ${icon("arrowright")}</a></header>
        ${focus ? `<div class="personal-focus-callout"><span>${t("personal.mainFocus")}</span><strong>${esc(focus.title)}</strong><small>${esc(focus.detail || t("personal.focusFallback"))}</small></div>` : ""}
        <div class="personal-stack">${data.tasks.length ? data.tasks.slice(0, 5).map(taskItem).join("") : `<div class="personal-empty">${icon("check")}<strong>${t("personal.noOpenTasks")}</strong><span>${t("personal.chooseFocus")}</span></div>`}</div>
      </section>
      <section class="personal-panel">
        <header><div><span>${t("personal.control")}</span><h3>${t("personal.waitingApprovals")}</h3></div><button class="link-button" data-open-tab="approvals">${t("personal.all")}</button></header>
        <div class="personal-stack">${data.approvals.length ? data.approvals.slice(0, 3).map((item) => approvalItem(item, true)).join("") : `<div class="personal-empty">${icon("guardrails")}<strong>${t("personal.nothingWaiting")}</strong><span>${t(data.approvalsAvailable ? "personal.noAgentRequests" : "personal.operatorOnly")}</span></div>`}</div>
      </section>
      <section class="personal-panel">
        <header><div><span>${t("personal.context")}</span><h3>${t("personal.latestMemory")}</h3></div><button class="link-button" data-open-tab="memory">${t("personal.open")}</button></header>
        <div class="personal-note-stream">${data.notes.length ? data.notes.slice(0, 4).map((note) => `<a href="#/my-notes/${encodeURIComponent(note.id)}">${icon("file")}<span><strong>${esc(note.title)}</strong><small>${t("personal.updated", { date: shortDate(note.updatedAt) })}</small></span>${icon("chevright")}</a>`).join("") : `<div class="personal-empty">${icon("file")}<strong>${t("personal.emptyMemory")}</strong><span>${t("personal.createMemory")}</span></div>`}</div>
      </section>
    </div>
    <section class="personal-sources">
      <header><div><span>${t("personal.daySources")}</span><h3>${t("personal.connections")}</h3></div></header>
      <div>${sourceRow(t("personal.source.tasks"), "tasks", "evaluations", "#/my-tasks")}${sourceRow(t("personal.source.notes"), "notes", "knowledge", "#/my-notes")}${sourceRow("MILA", "mila", "mic", "#/chat")}${googleSource(t("personal.source.calendar"), "calendar", "calendar")}${googleSource(t("personal.source.inbox"), "inbox", "mail")}</div>
    </section>
  </section>`;
}

function soulView() {
  const profile = data.profile || {};
  return `<div class="personal-split">
    <section class="personal-panel">
      <header><div><span>${t("personal.assistantBehavior")}</span><h3>${t("personal.milaSettings")}</h3></div></header>
      <form class="personal-profile-form" data-profile-form>
        <div class="personal-form-grid">
          <div class="field"><label class="label">${t("personal.language")}</label><select class="select" data-profile-locale>
            <option value="ru-RU" ${profile.locale === "ru-RU" ? "selected" : ""}>Русский</option>
            <option value="uz-UZ" ${profile.locale === "uz-UZ" ? "selected" : ""}>O‘zbekcha</option>
            <option value="en-US" ${profile.locale === "en-US" ? "selected" : ""}>English</option>
          </select></div>
          <div class="field"><label class="label">${t("personal.timezone")}</label><input class="input" data-profile-timezone maxlength="80" value="${esc(profile.timezone || "Asia/Tashkent")}"/></div>
        </div>
        <div class="field"><label class="label">${t("personal.workFocus")}</label><input class="input" data-profile-focus maxlength="160" value="${esc(profile.roleFocus || "")}" placeholder="${t("personal.workFocusPlaceholder")}"/></div>
        <div class="personal-form-grid">
          <div class="field"><label class="label">${t("personal.milaStyle")}</label><select class="select" data-profile-style>
            ${["assistant", "friend", "operator", "mentor"].map((value) => `<option value="${value}" ${profile.assistantStyle === value ? "selected" : ""}>${t(`personal.style.${value}`)}</option>`).join("")}
          </select></div>
          <div class="field"><label class="label">${t("personal.answerLength")}</label><select class="select" data-profile-length>
            <option value="brief" ${profile.responseLength === "brief" ? "selected" : ""}>${t("personal.length.brief")}</option>
            <option value="balanced" ${profile.responseLength === "balanced" ? "selected" : ""}>${t("personal.length.balanced")}</option>
          </select></div>
        </div>
        <footer><span data-profile-state>${t("personal.syncHint")}</span><button class="btn btn-primary" type="submit">${icon("save")}${t("personal.save")}</button></footer>
      </form>
    </section>
    <section class="personal-panel personal-soul-preview">
      <header><div><span>${t("personal.longTermProfile")}</span><h3>SOUL.md</h3></div><button class="btn btn-secondary sm" data-sync-soul>${icon("refresh")}${t("personal.sync")}</button></header>
      <div class="personal-file-path">${icon("file")}<code>${esc(data.soul.path)}</code></div>
      <pre>${esc(data.soul.content)}</pre>
    </section>
  </div>`;
}

function memoryView(query = "") {
  const normalized = query.trim().toLowerCase();
  const notes = normalized ? data.notes.filter((note) => `${note.title} ${note.content || ""}`.toLowerCase().includes(normalized)) : data.notes;
  return `<section class="personal-panel personal-memory">
    <header><div><span>${t("personal.personalContext")}</span><h3>${t("personal.memoryNotes")}</h3></div><a class="btn btn-primary sm" href="#/my-notes">${icon("plus")}${t("personal.newNote")}</a></header>
    <div class="personal-memory-search">${icon("search")}<input data-memory-search value="${esc(query)}" placeholder="${t("personal.searchMemory")}"/></div>
    <div class="personal-memory-grid">${notes.length ? notes.map((note) => `<a href="#/my-notes/${encodeURIComponent(note.id)}"><span class="personal-memory-glyph">${icon("file")}</span><div><strong>${esc(note.title)}</strong><p>${esc((note.content || t("personal.emptyNote")).slice(0, 180))}</p><small>${t("personal.updated", { date: shortDate(note.updatedAt) })}</small></div></a>`).join("") : `<div class="personal-empty wide">${icon("search")}<strong>${t("personal.notFound")}</strong><span>${t("personal.changeQuery")}</span></div>`}</div>
    <div class="personal-context-callout">${icon("network")}<div><strong>${t("personal.obsidianTitle")}</strong><span>${t("personal.obsidianText")}</span></div>${api.auth.canAdmin ? `<a class="btn btn-secondary sm" href="#/knowledge">${t("personal.openGraph")}</a>` : ""}</div>
  </section>`;
}

function fileSize(value) {
  return value < 1024 ? `${value} B` : `${Math.round(value / 1024)} KB`;
}

function filesView() {
  return `<section class="personal-panel personal-memory">
    <header><div><span>${t("personal.privateFiles")}</span><h3>${t("personal.fileLibrary")}</h3></div><label class="btn btn-primary sm">${icon("plus")}${t("personal.upload")}<input type="file" data-personal-file hidden></label></header>
    <div class="personal-memory-grid">${data.files?.length ? data.files.map((item) => `<article>
      <span class="personal-memory-glyph">${icon("file")}</span>
      <div><strong>${esc(item.name)}</strong><p>${esc(item.type)} · ${fileSize(item.size)}</p><small>${shortDate(item.createdAt)}</small></div>
      <div><a class="icon-btn" href="/api/personal/files/${encodeURIComponent(item.id)}/download" title="${t("personal.download")}">${icon("download")}</a><button class="icon-btn" data-file-delete="${esc(item.id)}" title="${t("personal.delete")}">${icon("trash")}</button></div>
    </article>`).join("") : `<div class="personal-empty wide">${icon("file")}<strong>${t("personal.noFiles")}</strong><span>${t("personal.filesHint")}</span></div>`}</div>
  </section>`;
}

function approvalsView() {
  return `<section class="personal-panel personal-approvals">
    <header><div><span>${t("personal.actionSafety")}</span><h3>${t("personal.approvalQueue")}</h3></div><span class="badge ${data.approvals.length ? "warning" : "success"}">${t("personal.waitingCount", { count: data.approvals.length })}</span></header>
    <div class="personal-approval-list">${data.approvals.length ? data.approvals.map((item) => approvalItem(item)).join("") : `<div class="personal-empty wide">${icon("guardrails")}<strong>${t("personal.underControl")}</strong><span>${t(data.approvalsAvailable ? "personal.noDecisions" : "personal.memberSafe")}</span></div>`}</div>
    <div class="personal-policy">${icon("info")}${t("personal.policy")}</div>
  </section>`;
}

function accountView() {
  const account = data.account;
  return `<div class="personal-account-grid">
    <section class="personal-panel personal-account-card">
      <header><div><span>${t("personal.profile")}</span><h3>${t("personal.unifiedAccount")}</h3></div><span class="badge success">${t("personal.status.active")}</span></header>
      <div class="personal-account-identity"><span>${esc((account.name || "U").slice(0, 1).toUpperCase())}</span><div><h2>${esc(account.name)}</h2><p>${esc(account.email || t("personal.creatorAccount"))}</p></div></div>
      <dl><div><dt>${t("personal.role")}</dt><dd>${esc(account.role)}</dd></div><div><dt>${t("personal.workspace")}</dt><dd>${esc(data.workspace.name)}</dd></div><div><dt>${t("personal.language")}</dt><dd>${esc(data.profile.locale || "ru-RU")}</dd></div><div><dt>${t("personal.timezone")}</dt><dd>${esc(data.profile.timezone || "Asia/Tashkent")}</dd></div></dl>
    </section>
    <section class="personal-panel">
      <header><div><span>${t("personal.syncSection")}</span><h3>${t("personal.webMobile")}</h3></div></header>
      <div class="personal-device-row">${icon("cloud")}<div><strong>${t("personal.serverProfile")}</strong><span>${t("personal.serverProfileText")}</span></div><span class="badge success">${t("personal.status.connected")}</span></div>
      <div class="personal-device-row">${icon("mic")}<div><strong>${t("personal.milaVoice")}</strong><span>${t("personal.milaVoiceText")}</span></div><span class="badge success">${t("personal.status.connected")}</span></div>
      <div class="personal-device-row">${icon("shield")}<div><strong>${t("personal.activeSessions")}</strong><span>${t("personal.sessionsPlanned")}</span></div><span class="badge neutral">${t("personal.status.planned")}</span></div>
      <a class="btn btn-secondary" href="#/settings">${icon("settings")}${t("personal.accountSettings")}</a>
    </section>
  </div>`;
}

function content() {
  if (!data) return `<div class="member-loading"><span></span><span></span><span></span></div>`;
  if (activeTab === "soul") return soulView();
  if (activeTab === "memory") return memoryView();
  if (activeTab === "files") return filesView();
  if (activeTab === "approvals") return approvalsView();
  if (activeTab === "account") return accountView();
  return todayView();
}

function openTab(root, tab) {
  activeTab = tabs.some(([id]) => id === tab) ? tab : "today";
  root.innerHTML = shell();
  wire(root);
}

async function reload(root, tab = activeTab) {
  data = await api.personal.dashboard();
  openTab(root, tab);
}

function wire(root) {
  root.querySelector("[data-personal-file]")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",").at(-1));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api.personal.uploadFile({ name: file.name, type: file.type, base64 });
      await reload(root, "files");
      toast("success", t("personal.fileUploaded"));
    } catch (error) { toast("error", t("personal.fileError"), error.message); }
  });
  root.querySelectorAll("[data-file-delete]").forEach((button) => button.onclick = async () => {
    button.disabled = true;
    try {
      await api.personal.deleteFile(button.dataset.fileDelete);
      await reload(root, "files");
    } catch (error) { button.disabled = false; toast("error", t("personal.fileError"), error.message); }
  });
  root.querySelectorAll("[data-google-connect]").forEach((button) => button.onclick = async () => {
    button.disabled = true;
    try {
      if (data.google?.connected) {
        await api.personal.googleDisconnect();
        await reload(root, "today");
        toast("success", t("personal.googleDisconnected"));
      } else {
        const result = await api.personal.googleConnect();
        location.assign(result.authorizationUrl);
      }
    } catch (error) {
      button.disabled = false;
      toast("error", t("personal.googleError"), error.message);
    }
  });
  root.querySelectorAll("[data-personal-tab]").forEach((button) => button.onclick = () => openTab(root, button.dataset.personalTab));
  root.querySelectorAll("[data-open-tab]").forEach((button) => button.onclick = () => openTab(root, button.dataset.openTab));
  root.querySelector("[data-personal-new]")?.addEventListener("click", () => {
    location.hash = "#/my-tasks/new";
  });
  root.querySelector("[data-capture-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = root.querySelector("[data-capture-input]");
    const title = input.value.trim();
    if (title.length < 2) return input.focus();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      await api.member.createTask({ title, status: "todo", priority: "normal" });
      toast("success", t("personal.taskAdded"));
      await reload(root, "today");
    } catch (error) {
      button.disabled = false;
      toast("error", t("personal.taskCreateError"), error.message);
    }
  });
  root.querySelectorAll("[data-personal-done]").forEach((button) => button.onclick = async () => {
    button.disabled = true;
    try {
      await api.member.updateTask(button.dataset.personalDone, { status: "done" });
      await reload(root, "today");
      toast("success", t("personal.taskDone"));
    } catch (error) { button.disabled = false; toast("error", t("personal.taskUpdateError"), error.message); }
  });
  root.querySelector("[data-profile-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    const state = root.querySelector("[data-profile-state]");
    button.disabled = true;
    state.textContent = t("personal.saving");
    try {
      const current = await api.onboarding.get();
      const result = await api.onboarding.save({
        profile: {
          locale: root.querySelector("[data-profile-locale]").value,
          timezone: root.querySelector("[data-profile-timezone]").value,
          roleFocus: root.querySelector("[data-profile-focus]").value,
          assistantStyle: root.querySelector("[data-profile-style]").value,
          responseLength: root.querySelector("[data-profile-length]").value,
        },
        ...(current.canEditWorkspace ? { workspace: current.workspace } : {}),
      });
      const locale = setLocale(result.profile?.locale || root.querySelector("[data-profile-locale]").value);
      milaHub.setLanguage(locale);
      await reload(root, "soul");
      window.dispatchEvent(new CustomEvent("aos:locale-change"));
      toast("success", t("personal.profileSaved"), t("personal.soulSyncedObsidian"));
    } catch (error) {
      button.disabled = false;
      state.textContent = error.message;
      toast("error", t("personal.profileSaveError"), error.message);
    }
  });
  root.querySelector("[data-sync-soul]")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      await api.onboarding.sync();
      await reload(root, "soul");
      toast("success", t("personal.soulSynced"));
    } catch (error) { event.currentTarget.disabled = false; toast("error", t("personal.syncError"), error.message); }
  });
  const search = root.querySelector("[data-memory-search]");
  if (search) search.oninput = () => {
    const host = root.querySelector(".personal-memory-grid");
    const temp = document.createElement("div");
    temp.innerHTML = memoryView(search.value);
    host.replaceWith(temp.querySelector(".personal-memory-grid"));
  };
  root.querySelectorAll("[data-approval]").forEach((button) => button.onclick = async () => {
    const id = button.dataset.approval;
    if (!id) return toast("error", t("personal.missingApproval"));
    root.querySelectorAll(`[data-approval="${CSS.escape(id)}"]`).forEach((item) => { item.disabled = true; });
    try {
      await api.pulse.decideApproval(id, button.dataset.decision);
      await reload(root, "approvals");
      toast("success", t(button.dataset.decision === "approve" ? "personal.approved" : "personal.rejected"));
    } catch (error) { await reload(root, "approvals"); toast("error", t("personal.decisionError"), error.message); }
  });
}

const personal = {
  title: t("personal.title"),
  render: () => `<div id="personalPage"><div class="member-loading"><span></span><span></span><span></span></div></div>`,
  async mount(root, ctx) {
    try {
      activeTab = ctx.params?.[0] || "today";
      data = await api.personal.dashboard();
      root.innerHTML = shell();
      wire(root);
    } catch (error) {
      root.innerHTML = `<div class="empty member-empty">${icon("alert")}<h4>${t("personal.unavailable")}</h4><p>${esc(error.message)}</p></div>`;
    }
  },
};

export default personal;
