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
let plan = null;
let planError = "";
let milaBrief = "";
let milaBusy = false;

function clock(value, timezone) {
  try {
    return new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false })
      .format(new Date(value));
  } catch {
    return String(value || "").slice(11, 16);
  }
}

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

function agendaItem(item, timezone) {
  const time = item.allDay
    ? t("personal.plan.allDay")
    : `${clock(item.start, timezone)}–${clock(item.end, timezone)}`;
  const focus = item.kind === "focus";
  const label = focus ? t("personal.plan.focusBlock") : t("personal.plan.meeting");
  const body = `<span class="personal-agenda-time">${esc(time)}</span>
    <span class="personal-agenda-body"><strong>${esc(item.title)}</strong><small>${esc([label, item.detail].filter(Boolean).join(" · "))}</small></span>
    <span class="personal-agenda-kind ${focus ? "focus" : "event"}">${icon(focus ? "zap" : "calendar")}</span>`;
  if (focus) {
    return `<article class="personal-agenda-item focus">${body}
      <button class="icon-btn tip" data-personal-done="${esc(item.taskId)}" data-tip="${t("personal.task.doneTip")}" aria-label="${t("personal.task.doneAria")}">${icon("check")}</button>
    </article>`;
  }
  return item.link
    ? `<a class="personal-agenda-item" href="${esc(item.link)}" target="_blank" rel="noopener">${body}</a>`
    : `<div class="personal-agenda-item">${body}</div>`;
}

function alertItem(item) {
  return `<article class="personal-alert ${item.level === "high" ? "high" : "normal"}">
    ${icon(item.level === "high" ? "alert" : "info")}
    <div><strong>${esc(item.title)}</strong>${item.detail ? `<small>${esc(item.detail)}</small>` : ""}</div>
    ${item.route ? `<a class="btn btn-ghost sm" href="${esc(item.route)}">${t("personal.open")}</a>` : ""}
  </article>`;
}

function planPanel() {
  if (planError) {
    return `<section class="personal-panel personal-agenda">
      <header><div><span>${t("personal.plan.eyebrow")}</span><h3>${t("personal.plan.title")}</h3></div><button class="link-button" data-plan-refresh>${t("personal.plan.refresh")}</button></header>
      <div class="personal-empty">${icon("alert")}<strong>${t("personal.plan.unavailable")}</strong><span>${esc(planError)}</span></div>
    </section>`;
  }
  if (!plan) {
    return `<section class="personal-panel personal-agenda"><header><div><span>${t("personal.plan.eyebrow")}</span><h3>${t("personal.plan.title")}</h3></div></header><div class="skeleton" style="height:120px"></div></section>`;
  }
  const zone = plan.timezone;
  const stats = plan.stats || {};
  return `<section class="personal-panel personal-agenda">
    <header>
      <div><span>${t("personal.plan.eyebrow")}</span><h3>${t("personal.plan.title")}</h3></div>
      <button class="link-button" data-plan-refresh>${t("personal.plan.refresh")}</button>
    </header>
    <div class="personal-plan-stats">
      <span>${icon("calendar")}${t("personal.plan.meetings", { count: stats.events || 0 })}</span>
      <span>${icon("zap")}${t("personal.plan.focusCount", { count: stats.focusBlocks || 0 })}</span>
      <span>${icon("clock")}${t("personal.plan.free", { minutes: stats.freeMinutes || 0 })}</span>
      <span class="personal-plan-window">${esc(plan.workday?.startLabel || "")}–${esc(plan.workday?.endLabel || "")}</span>
    </div>
    ${plan.calendar?.scopeStale ? `<div class="personal-policy warning">${icon("warn")}${t("personal.plan.scopeStale")}<button class="btn btn-secondary sm" data-google-reconnect>${t("personal.plan.reconnect")}</button></div>` : ""}
    <div class="personal-agenda-list">${plan.agenda?.length
      ? plan.agenda.map((item) => agendaItem(item, zone)).join("")
      : `<div class="personal-empty">${icon("calendar")}<strong>${t("personal.plan.empty")}</strong><span>${t("personal.plan.emptyHint")}</span></div>`}</div>
    ${plan.unplaced?.length ? `<div class="personal-policy">${icon("info")}${t("personal.plan.unplaced", { count: plan.unplaced.length })}</div>` : ""}
  </section>`;
}

function milaPanel() {
  return `<section class="personal-panel personal-mila">
    <header><div><span>${t("personal.mila.eyebrow")}</span><h3>${t("personal.mila.title")}</h3></div></header>
    <p class="personal-mila-hint">${t("personal.mila.hint")}</p>
    <div class="personal-mila-actions">
      <button class="btn btn-primary" data-mila-call>${icon("mic")}${t("personal.mila.call")}</button>
      <button class="btn btn-secondary" data-mila-brief ${milaBusy ? "disabled" : ""}>${icon("sparkles")}${t(milaBusy ? "personal.mila.thinking" : "personal.mila.brief")}</button>
      <a class="btn btn-ghost" href="#/chat">${icon("chat")}${t("personal.mila.chat")}</a>
    </div>
    ${milaBrief ? `<div class="personal-mila-answer">${esc(milaBrief)}</div>` : ""}
  </section>`;
}

function remindersPanel() {
  const items = data.reminders || [];
  return `<section class="personal-panel">
    <header><div><span>${t("personal.reminders.eyebrow")}</span><h3>${t("personal.reminders.title")}</h3></div></header>
    <div class="personal-stack">${items.length ? items.slice(0, 5).map((item) => `<article class="personal-task">
      <span class="member-priority ${item.priority === "high" ? "high" : "normal"}"></span>
      <div><strong>${esc(item.title)}</strong><small>${esc(localizedDate(item.dueAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</small></div>
      <button class="icon-btn" data-reminder-cancel="${esc(item.id)}" aria-label="${t("personal.reminders.cancel")}">${icon("x")}</button>
    </article>`).join("") : `<div class="personal-empty">${icon("clock")}<strong>${t("personal.reminders.empty")}</strong><span>${t("personal.reminders.emptyHint")}</span></div>`}</div>
  </section>`;
}

function todayView() {
  const briefing = briefingCopy();
  const summary = plan?.summary || briefing.summary;
  const load = plan?.stats?.load ?? data.briefing.load;
  return `<section class="personal-today">
    <div class="personal-briefing">
      <div class="personal-briefing-icon">${icon("sparkles")}</div>
      <div><span>${t("personal.briefing")}</span><h2>${esc(briefing.greeting)}</h2><p>${esc(summary)}</p></div>
      <div class="personal-load"><strong>${load}%</strong><span>${t("personal.load")}</span><i><b style="width:${load}%"></b></i></div>
    </div>
    <form class="personal-capture" data-capture-form>
      ${icon("command")}<input maxlength="160" data-capture-input placeholder="${t("personal.capture")}"/>
      <button class="btn btn-primary" type="submit">${icon("plus")}${t("personal.add")}</button>
    </form>
    ${plan?.next ? `<div class="personal-focus-callout wide"><span>${t("personal.plan.next")}</span><strong>${esc(plan.next.title)}</strong><small>${esc(plan.next.allDay ? t("personal.plan.allDay") : `${clock(plan.next.start, plan.timezone)}–${clock(plan.next.end, plan.timezone)}`)}</small></div>` : ""}
    ${planPanel()}
    <div class="personal-today-grid">
      ${milaPanel()}
      <section class="personal-panel">
        <header><div><span>${t("personal.plan.alertsEyebrow")}</span><h3>${t("personal.plan.alerts")}</h3></div></header>
        <div class="personal-stack">${plan?.alerts?.length
          ? plan.alerts.slice(0, 6).map(alertItem).join("")
          : `<div class="personal-empty">${icon("check")}<strong>${t("personal.plan.noAlerts")}</strong><span>${t("personal.plan.noAlertsHint")}</span></div>`}</div>
      </section>
      <section class="personal-panel personal-focus">
        <header><div><span>${t("personal.plan")}</span><h3>${t("personal.priorityTasks")}</h3></div><a href="#/my-tasks">${t("personal.allTasks")} ${icon("arrowright")}</a></header>
        <div class="personal-stack">${data.tasks.length ? data.tasks.slice(0, 5).map(taskItem).join("") : `<div class="personal-empty">${icon("check")}<strong>${t("personal.noOpenTasks")}</strong><span>${t("personal.chooseFocus")}</span></div>`}</div>
      </section>
      ${remindersPanel()}
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
          <div class="field"><label class="label">${t("personal.workdayStart")}</label><input class="input" type="time" data-profile-workday-start value="${esc(profile.workdayStart || "09:00")}"/></div>
          <div class="field"><label class="label">${t("personal.workdayEnd")}</label><input class="input" type="time" data-profile-workday-end value="${esc(profile.workdayEnd || "18:00")}"/></div>
        </div>
        <div class="personal-form-grid">
          <div class="field"><label class="label">${t("personal.lunchStart")}</label><input class="input" type="time" data-profile-lunch-start value="${esc(profile.lunchStart || "13:00")}"/></div>
          <div class="field"><label class="label">${t("personal.lunchEnd")}</label><input class="input" type="time" data-profile-lunch-end value="${esc(profile.lunchEnd || "14:00")}"/></div>
        </div>
        <p class="hint">${t("personal.workdayHint")}</p>
        <div class="personal-form-grid">
          <div class="field"><label class="label">${t("personal.briefTime")}</label><input class="input" type="time" data-profile-brief-time value="${esc(profile.briefTime || "08:00")}"/></div>
          <div class="field"><label class="label">${t("personal.briefEnabled")}</label>
            <label class="mila-toggle-row"><input type="checkbox" data-profile-brief-enabled ${profile.briefEnabled === false ? "" : "checked"}/><span>${t("personal.briefEnabledHint")}</span></label>
            <label class="mila-toggle-row"><input type="checkbox" data-profile-brief-voice ${profile.briefVoice === true ? "checked" : ""}/><span>${t("personal.briefVoiceHint")}</span></label>
          </div>
        </div>
        <div class="personal-mila-actions"><button class="btn btn-secondary sm" type="button" data-brief-now>${icon("send")}${t("personal.briefNow")}</button></div>
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

// Personal Telegram delivery. Linking is one tap on a deep link, and the panel
// says plainly where things will arrive and how to turn it off — a channel into
// someone's personal messenger must never be a surprise.
function telegramPanel() {
  const tg = data.telegram || {};
  const status = !tg.configured
    ? `<p class="personal-knows-hint">${t("personal.tg.notConfigured")}</p>`
    : tg.linked
      ? `<p class="personal-knows-hint">${t("personal.tg.linked", { username: tg.username ? "@" + esc(tg.username) : "Telegram" })}</p>
        <button class="btn btn-secondary sm" data-tg-unlink>${icon("x")}${t("personal.tg.unlink")}</button>`
      : `<p class="personal-knows-hint">${t("personal.tg.hint")}</p>
        <button class="btn btn-primary sm" data-tg-link>${icon("send")}${t("personal.tg.link")}</button>`;
  return `<section class="personal-panel personal-telegram">
    <header><div><span>Telegram</span><h3>${t("personal.tg.title")}</h3></div>
    ${tg.linked ? `<span class="badge success">${t("personal.tg.on")}</span>` : `<span class="badge neutral">${t("personal.tg.off")}</span>`}</header>
    ${status}
    <div class="personal-tg-slot" data-tg-slot></div>
  </section>`;
}

// What MILA has been told about the owner. It shapes every answer she gives, so
// it has to be visible and removable somewhere other than by asking her.
function profileFactsPanel() {
  const facts = data.profileFacts || [];
  const categories = data.profileCategories || [];
  const labelOf = (id) => categories.find((category) => category.id === id)?.label || id;
  const grouped = new Map();
  for (const fact of facts) {
    if (!grouped.has(fact.category)) grouped.set(fact.category, []);
    grouped.get(fact.category).push(fact);
  }
  return `<section class="personal-panel personal-knows">
    <header>
      <div><span>${t("personal.knows.eyebrow")}</span><h3>${t("personal.knows.title")}</h3></div>
      <span class="badge neutral">${t("personal.knows.count", { count: facts.length })}</span>
    </header>
    <p class="personal-knows-hint">${t("personal.knows.hint")}</p>
    <form class="personal-capture personal-knows-add" data-fact-form>
      ${icon("brain")}<input maxlength="400" data-fact-input placeholder="${t("personal.knows.placeholder")}"/>
      <button class="btn btn-secondary sm" type="submit">${icon("plus")}${t("personal.knows.add")}</button>
    </form>
    ${facts.length ? [...grouped.entries()].map(([category, items]) => `<div class="personal-knows-group">
      <div class="personal-knows-cat">${esc(labelOf(category))}</div>
      ${items.map((fact) => `<div class="personal-knows-fact">
        <span>${esc(fact.text)}</span>
        <button class="icon-btn sm" data-forget="${esc(fact.id)}" title="${t("personal.knows.forget")}" aria-label="${t("personal.knows.forget")}">${icon("x")}</button>
      </div>`).join("")}
    </div>`).join("") : `<div class="personal-empty">${icon("brain")}<strong>${t("personal.knows.empty")}</strong><span>${t("personal.knows.emptyHint")}</span></div>`}
  </section>`;
}

function memoryView(query = "") {
  const normalized = query.trim().toLowerCase();
  const notes = normalized ? data.notes.filter((note) => `${note.title} ${note.content || ""}`.toLowerCase().includes(normalized)) : data.notes;
  return `${telegramPanel()}${profileFactsPanel()}<section class="personal-panel personal-memory">
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

// The plan and the reminder list are allowed to fail on their own: a calendar that
// times out must not take the whole Personal page down with it.
async function loadPlan({ refresh = false } = {}) {
  try {
    plan = await api.personal.plan({ refresh });
    planError = "";
  } catch (error) {
    plan = null;
    planError = error.message;
  }
}

async function loadSide() {
  // Independent of each other and of the plan: one failing must not blank the
  // others, so each settles on its own.
  const [reminders, profile, telegramStatus] = await Promise.allSettled([
    api.personal.reminders(),
    api.personal.profileFacts(),
    api.personal.telegramStatus(),
  ]);
  data.telegram = telegramStatus.status === "fulfilled" ? telegramStatus.value : { configured: false };
  data.reminders = reminders.status === "fulfilled" ? (reminders.value.reminders || []) : [];
  data.profileFacts = profile.status === "fulfilled" ? (profile.value.facts || []) : [];
  data.profileCategories = profile.status === "fulfilled" ? (profile.value.categories || []) : [];
}

async function reload(root, tab = activeTab, { refreshPlan = false } = {}) {
  data = await api.personal.dashboard();
  await Promise.all([loadPlan({ refresh: refreshPlan }), loadSide()]);
  openTab(root, tab);
}

function wire(root) {
  root.querySelector("[data-plan-refresh]")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    await reload(root, "today", { refreshPlan: true });
  });
  root.querySelector("[data-google-reconnect]")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      const result = await api.personal.googleConnect();
      location.assign(result.authorizationUrl);
    } catch (error) {
      event.currentTarget.disabled = false;
      toast("error", t("personal.googleError"), error.message);
    }
  });
  root.querySelector("[data-mila-call]")?.addEventListener("click", async () => {
    try {
      if (!milaHub.active) await milaHub.start();
    } catch (error) { toast("error", t("personal.mila.callError"), error.message); }
  });
  root.querySelector("[data-mila-brief]")?.addEventListener("click", async () => {
    milaBusy = true;
    openTab(root, "today");
    try {
      await milaHub.sendWritten(t("personal.mila.prompt"));
      const answer = milaHub.snapshot().history.filter((item) => item.role === "assistant").at(-1);
      milaBrief = answer?.text || "";
    } catch (error) {
      toast("error", t("personal.mila.briefError"), error.message);
    } finally {
      milaBusy = false;
      openTab(root, "today");
    }
  });
  root.querySelectorAll("[data-reminder-cancel]").forEach((button) => button.onclick = async () => {
    button.disabled = true;
    try {
      await api.personal.cancelReminder(button.dataset.reminderCancel);
      await reload(root, "today");
    } catch (error) { button.disabled = false; toast("error", t("personal.reminders.cancelError"), error.message); }
  });
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
          workdayStart: root.querySelector("[data-profile-workday-start]").value,
          workdayEnd: root.querySelector("[data-profile-workday-end]").value,
          lunchStart: root.querySelector("[data-profile-lunch-start]").value,
          lunchEnd: root.querySelector("[data-profile-lunch-end]").value,
          briefTime: root.querySelector("[data-profile-brief-time]").value,
          briefEnabled: root.querySelector("[data-profile-brief-enabled]").checked,
          briefVoice: root.querySelector("[data-profile-brief-voice]").checked,
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
  root.querySelector("[data-tg-link]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const { url } = await api.personal.telegramLink();
      const slot = root.querySelector("[data-tg-slot]");
      // The link opens Telegram itself; the code inside is one-time and short-lived.
      if (slot) slot.innerHTML = `<a class="btn btn-primary sm" href="${esc(url)}" target="_blank" rel="noopener">${icon("send")}${t("personal.tg.open")}</a>
        <span class="personal-knows-hint">${t("personal.tg.after")}</span>`;
      window.open(url, "_blank", "noopener");
    } catch (error) {
      toast("error", "Telegram", error.message);
      button.disabled = false;
    }
  });
  root.querySelector("[data-tg-unlink]")?.addEventListener("click", async () => {
    try {
      await api.personal.telegramUnlink();
      await reload(root, activeTab);
    } catch (error) { toast("error", "Telegram", error.message); }
  });
  root.querySelector("[data-fact-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = root.querySelector("[data-fact-input]");
    const fact = input.value.trim();
    if (fact.length < 3) return input.focus();
    try {
      await api.personal.rememberFact({ fact });
      input.value = "";
      await reload(root, "memory");
      toast("success", t("personal.knows.added"));
    } catch (error) { toast("error", t("personal.knows.error"), error.message); }
  });
  root.querySelectorAll("[data-forget]").forEach((button) => button.onclick = async () => {
    button.disabled = true;
    try {
      await api.personal.forgetFact(button.dataset.forget);
      await reload(root, "memory");
    } catch (error) { button.disabled = false; toast("error", t("personal.knows.error"), error.message); }
  });
  root.querySelector("[data-brief-now]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api.personal.sendBrief();
      toast("success", t("personal.briefSent"), t("personal.briefSentHint", { date: result.date }));
    } catch (error) { toast("error", t("personal.briefError"), error.message); }
    button.disabled = false;
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
      await Promise.all([loadPlan(), loadSide()]);
      openTab(root, activeTab);
    } catch (error) {
      root.innerHTML = `<div class="empty member-empty">${icon("alert")}<h4>${t("personal.unavailable")}</h4><p>${esc(error.message)}</p></div>`;
    }
  },
};

export default personal;
