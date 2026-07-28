import { store } from "./store.js";
import { brandMark } from "./brand.js";
import { icon } from "./icons.js";
import { api } from "./api.js";
import { el, qs, qsa, agentIcon, initials, esc, closeOverlay, toast } from "./ui.js";
import { mountMilaDock } from "./mila-dock.js";
import { renderOnboarding } from "./onboarding.js";
import { SUPPORTED_LOCALES, getLocale, setLocale, t as tr } from "./i18n.js";
import { saveProfileLocale } from "./profile-locale.js";

import dashboard from "./pages/dashboard.js";
import agents from "./pages/agents.js";
import missions from "./pages/missions.js";
import hermes from "./pages/hermes.js";
import claude from "./pages/claude-code.js";
import mila from "./pages/mila.js";
import chat from "./pages/chat.js";
import workflows from "./pages/workflows.js";
import settings from "./pages/settings.js";
import speech from "./pages/speech.js";
import routines from "./pages/routines.js";
import components from "./pages/components.js";
import personal from "./pages/personal.js";
import { memberHome, memberNotes, memberTasks } from "./pages/member.js";
import * as misc from "./pages/misc.js";

/* ---------------- Navigation config ---------------- */
const OPERATOR_NAV = [
  { group: null, items: [
    { route: "", icon: "home", label: "Home" },
    { route: "personal", icon: "user", label: "Personal" },
    { route: "missions", icon: "rocket", label: "Missions" },
    { route: "hermes", icon: "brain", label: "Hermes Control" },
    { route: "claude", icon: "code", label: "Claude Workspace" },
    { route: "mila", icon: "mic", label: "Mila Live" },
    { route: "speech", icon: "mic", label: "Speech Studio" },
    { route: "agents", icon: "agents", label: "Agents" },
    { route: "chat", icon: "chat", label: "Chat" },
    { route: "kanban", icon: "workflow", label: "Kanban" },
    { route: "routines", icon: "calendar", label: "Routines" },
    { route: "tools", icon: "tools", label: "Skill Studio" },
  ]},
  { group: "Context", items: [
    { route: "knowledge", icon: "knowledge", label: "Obsidian Library" },
    { route: "memory", icon: "memory", label: "Memory" },
    { route: "mcp", icon: "mcp", label: "MCP Servers" },
    { route: "integrations", icon: "integrations", label: "Integrations" },
  ]},
  { group: "Operate", items: [
    { route: "evaluations", icon: "evaluations", label: "Evaluations" },
    { route: "observability", icon: "observability", label: "Observability" },
    { route: "guardrails", icon: "guardrails", label: "Guardrails" },
    { route: "secrets", icon: "secrets", label: "Secrets" },
    { route: "settings", icon: "settings", label: "Settings" },
  ]},
];

const MEMBER_NAV = [
  { group: null, items: [
    { route: "", icon: "home", label: "Home" },
    { route: "personal", icon: "user", label: "Personal" },
    { route: "chat", icon: "chat", label: "Mila Assistant" },
    { route: "my-tasks", icon: "evaluations", label: "My Tasks" },
    { route: "my-notes", icon: "knowledge", label: "My Notes" },
  ]},
  { group: "Account", items: [
    { route: "settings", icon: "settings", label: "Settings" },
  ]},
];

const OPERATOR_PAGES = {
  "": dashboard, personal, agents, missions, hermes, claude, mila, speech, chat, kanban: workflows, workflows, routines, settings, components,
  "my-tasks": memberTasks, "my-notes": memberNotes,
  tools: misc.tools, knowledge: misc.knowledge, memory: misc.memory,
  mcp: misc.mcp, integrations: misc.integrations, observability: misc.observability,
  guardrails: misc.guardrails, secrets: misc.secrets, evaluations: misc.evaluations,
};
const MEMBER_PAGES = { "": memberHome, personal, chat, "my-tasks": memberTasks, "my-notes": memberNotes, settings };
const navigation = () => api.auth.canAdmin ? OPERATOR_NAV : MEMBER_NAV;
const NAV_KEYS = {
  "": "home", personal: "personal", missions: "missions", hermes: "hermes", claude: "claude",
  mila: "mila", speech: "speech", agents: "agents", chat: "chat", kanban: "kanban",
  routines: "routines", tools: "tools", knowledge: "knowledge", memory: "memory", mcp: "mcp",
  integrations: "integrations", evaluations: "evaluations", observability: "observability",
  guardrails: "guardrails", secrets: "secrets", settings: "settings", "my-tasks": "myTasks",
  "my-notes": "myNotes",
};
const navLabel = (item) => tr(`nav.${NAV_KEYS[item.route] || item.route}`) || item.label;
const navGroup = (group) => tr(`nav.${String(group || "").toLowerCase()}`);

/* ---------------- Theme ---------------- */
export function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  store.set((s) => { s.settings.theme = t; });
}
function toggleTheme() {
  applyTheme(store.state.settings.theme === "dark" ? "light" : "dark");
  renderShell();
  route();
}

/* ---------------- Shell ---------------- */
function sidebarHTML() {
  const cur = currentRoute();
  const p = store.state.profile;
  const groups = navigation().map((g) => `
    ${g.group ? `<div class="nav-label">${navGroup(g.group)}</div>` : ""}
    <div class="nav-group">
      ${g.items.map((it) => `
        <a class="nav-item ${it.route === cur ? "active" : ""}" href="#/${it.route}">
          ${icon(it.icon)}<span>${navLabel(it)}</span>
          ${it.route === "agents" ? `<span class="nav-tag">5</span>` : ""}
        </a>`).join("")}
    </div>`).join("");
  return `<aside class="sidebar" id="sidebar">
    <div class="brand">
      <a class="brand-lockup" href="#/" aria-label="Mila · Agentic OS"></a>
      <span class="brand-badge">v1.0</span>
    </div>
    ${groups}
    <div class="sidebar-foot">
      <div class="user-chip">
        <div class="avatar" style="width:34px;height:34px">${p.avatar ? `<img src="${p.avatar}"/>` : initials(p.name)}</div>
        <div class="stack"><span class="u-name">${esc(p.name)}</span><span class="u-mail">${esc(p.email || (p.role === "Creator" ? tr("shell.projectOwner") : p.role || "User"))}</span></div>
        <button class="icon-btn" id="user-menu">${icon("more")}</button>
      </div>
    </div>
  </aside>`;
}

function topbarHTML() {
  const theme = store.state.settings.theme;
  const member = !api.auth.canAdmin;
  return `<header class="topbar">
    <button class="icon-btn menu-toggle" id="mtoggle">${icon("grid")}</button>
    <div class="search"><span>${icon("search")}</span><input id="globalSearch" placeholder="${tr(member ? "shell.searchMember" : "shell.searchOperator")}"/><kbd>⌘K</kbd></div>
    <div class="topbar-actions">
      <label class="ui-language tip" data-tip="${tr("shell.language")}">
        ${icon("chat")}
        <select id="interfaceLocale" aria-label="${tr("shell.language")}">
          ${SUPPORTED_LOCALES.map(([code, label]) => `<option value="${code}" ${getLocale() === code ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
      ${api.on ? `<span class="badge success"><span class="dot"></span>${tr("shell.live")}</span>` : `<span class="badge neutral">${tr("shell.demo")}</span>`}
      <button class="icon-btn" id="themeBtn" title="${tr("shell.theme")}">${icon(theme === "dark" ? "sun" : "moon")}</button>
      <button class="icon-btn" id="helpBtn" title="${tr("shell.help")}">${icon("help")}</button>
      ${api.auth.canAdmin ? `<button class="icon-btn" id="bellBtn" title="${tr("shell.notifications")}" style="position:relative">${icon("bell")}<span class="dot"></span></button>` : ""}
      ${api.auth.canWrite ? `<a class="btn btn-primary" href="#/${member ? "my-tasks/new" : "kanban/new"}" id="newAgentTop">${icon("plus")}<span>${tr("shell.newTask")}</span></a>` : ""}
    </div>
  </header>`;
}

export function renderShell() {
  const app = qs("#app");
  app.removeAttribute("aria-busy");
  app.innerHTML = `<div class="layout">${sidebarHTML()}<div class="main">${topbarHTML()}<div id="view"></div></div></div>`;
  wireShell();
}

function wireShell() {
  qs("#themeBtn").onclick = toggleTheme;
  const language = qs("#interfaceLocale");
  if (language) language.onchange = async () => {
    const previous = getLocale();
    language.disabled = true;
    try {
      const result = await saveProfileLocale(language.value);
      store.set((state) => { state.profile.locale = result.profile?.locale || language.value; });
      renderShell();
      route();
      toast("success", tr("personal.languageSaved"));
    } catch (error) {
      setLocale(previous);
      language.value = previous;
      language.disabled = false;
      toast("error", tr("personal.languageError"), error.message);
    }
  };
  const mt = qs("#mtoggle");
  if (mt) mt.onclick = () => qs("#sidebar").classList.toggle("open");
  qsa(".nav-item").forEach((a) => a.addEventListener("click", () => qs("#sidebar")?.classList.remove("open")));
  const gs = qs("#globalSearch");
  if (gs) { gs.readOnly = true; gs.addEventListener("focus", openCommandPalette); gs.addEventListener("click", openCommandPalette); }
  const bell = qs("#bellBtn");
  if (bell) bell.onclick = () => openNotifications(bell);
  const um = qs("#user-menu");
  if (um) um.onclick = () => import("./ui.js").then((m) => m.openMenu(um, [
    { label: store.state.profile.name },
    { text: tr("nav.personal"), icon: "user", onClick: () => (location.hash = "#/personal") },
    { text: tr("shell.settings"), icon: "settings", onClick: () => (location.hash = "#/settings") },
    ...(api.auth.canAdmin ? [{ text: tr("shell.componentLibrary"), icon: "layers", onClick: () => (location.hash = "#/components") }] : []),
    { sep: true },
    { text: tr("shell.signOut"), icon: "logout", danger: true, onClick: async () => { if (api.health?.auth) { try { await api.auth.logout(); } catch {} location.reload(); } else m.toast("info", tr("shell.signOut")); } },
  ], { align: "right", placement: "top" }));
}

/* ---------------- Command palette (⌘K) ---------------- */
function buildCommands() {
  const theme = store.state.settings.theme;
  const cmds = [];
  navigation().forEach((g) => g.items.forEach((it) => cmds.push({ group: tr("shell.pages"), icon: it.icon, text: navLabel(it), hint: "#/" + (it.route || ""), run: () => (location.hash = "#/" + it.route) })));
  if (api.auth.canAdmin) {
    cmds.push({ group: tr("shell.pages"), icon: "layers", text: tr("shell.componentLibrary"), hint: "#/components", run: () => (location.hash = "#/components") });
    [
      ["Hermes", "Primary orchestrator", "brain", "default"], ["Scout", "Research", "search", "scout"],
      ["Scribe", "Writing", "edit", "scribe"], ["Reach", "Growth", "up", "reach"], ["Dev", "Engineering", "code", "dev"],
    ].forEach(([name, role, agentIcon, profile]) => cmds.push({ group: tr("shell.agents"), icon: agentIcon, text: name, hint: role, run: () => (location.hash = `#/kanban/new/${profile}`) }));
  }
  cmds.push({ group: tr("shell.actions"), icon: "plus", text: tr(api.auth.canAdmin ? "shell.newKanbanTask" : "shell.newPersonalTask"), run: () => (location.hash = api.auth.canAdmin ? "#/kanban/new" : "#/my-tasks/new") });
  cmds.push({ group: tr("shell.actions"), icon: "chat", text: tr("shell.newChat"), run: () => (location.hash = "#/chat") });
  cmds.push({ group: tr("shell.actions"), icon: theme === "dark" ? "sun" : "moon", text: tr("shell.theme"), run: toggleTheme });
  cmds.push({ group: tr("shell.actions"), icon: "settings", text: tr("shell.openSettings"), run: () => (location.hash = "#/settings") });
  return cmds;
}
function openCommandPalette() {
  if (qs(".cmdk")) return;
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  const cmds = buildCommands();
  const root = qs("#overlay-root");
  const scrim = el(`<div class="scrim"></div>`);
  const box = el(`<div class="cmdk" role="dialog" aria-modal="true">
    <div class="cmdk-search">${icon("search")}<input id="cmdkInput" placeholder="${tr("shell.searchPalette")}" autocomplete="off"/></div>
    <div class="cmdk-list" id="cmdkList"></div>
    <div class="cmdk-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> ${tr("shell.navigate")}</span><span><kbd>↵</kbd> ${tr("shell.select")}</span><span><kbd>esc</kbd> ${tr("shell.close")}</span></div>
  </div>`);
  scrim.onclick = closeOverlay;
  root.append(scrim, box);
  const input = box.querySelector("#cmdkInput");
  const listEl = box.querySelector("#cmdkList");
  let filtered = cmds, active = 0;
  const draw = () => {
    const q = input.value.toLowerCase().trim();
    filtered = q ? cmds.filter((c) => (c.text + " " + c.group).toLowerCase().includes(q)) : cmds;
    active = 0;
    let html = "", last = null;
    if (!filtered.length) html = `<div class="cmdk-group">${tr("shell.noResults")}</div>`;
    filtered.forEach((c, i) => {
      if (c.group !== last) { html += `<div class="cmdk-group">${c.group}</div>`; last = c.group; }
      html += `<div class="cmdk-item ${i === active ? "active" : ""}" data-i="${i}">${icon(c.icon)}<span>${esc(c.text)}</span>${c.hint ? `<span class="k">${esc(c.hint)}</span>` : ""}</div>`;
    });
    listEl.innerHTML = html;
    listEl.querySelectorAll(".cmdk-item").forEach((elm) => (elm.onclick = () => run(+elm.dataset.i)));
  };
  const setActive = (i) => {
    if (!filtered.length) return;
    active = (i + filtered.length) % filtered.length;
    listEl.querySelectorAll(".cmdk-item").forEach((e) => e.classList.toggle("active", +e.dataset.i === active));
    listEl.querySelector(".cmdk-item.active")?.scrollIntoView({ block: "nearest" });
  };
  const run = (i) => { const c = filtered[i]; if (!c) return; closeOverlay(); c.run(); };
  input.oninput = draw;
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter") { e.preventDefault(); run(active); }
    else if (e.key === "Escape") { e.preventDefault(); closeOverlay(); }
  };
  draw();
  setTimeout(() => input.focus(), 30);
}

/* ---------------- Notifications ---------------- */
function openNotifications(anchor) {
  if (qs(".notif")) { qs(".notif").remove(); return; }
  const items = [
    { dot: "var(--success)", title: "Agent task completed", desc: "Research Agent · Market Research Report", at: "2m ago" },
    { dot: "var(--error)", title: "Agent failed", desc: "Content Writer · seo_check timed out", at: "18m ago" },
    { dot: "var(--info)", title: "New agent deployed", desc: "Content Agent is now active", at: "1h ago" },
    { dot: "var(--warning)", title: "Rate limit approaching", desc: "85% of quota used", at: "2h ago" },
  ];
  const panel = el(`<div class="notif">
    <div class="notif-head"><span class="fw-700">Notifications</span><div class="spacer"></div><button class="btn btn-ghost sm" id="notifClear">Mark all read</button></div>
    ${items.map((i) => `<div class="notif-item"><span class="notif-dot" style="background:${i.dot}"></span><div class="stack" style="min-width:0"><span class="fw-600 text-sm">${i.title}</span><span class="cell-sub">${i.desc}</span></div><div class="spacer"></div><span class="dim nowrap" style="font-size:11px">${i.at}</span></div>`).join("")}
    <div class="menu-sep"></div>
    <a class="menu-item" href="#/observability">${icon("activity")}<span>View all activity</span></a>
  </div>`);
  document.body.appendChild(panel);
  const r = anchor.getBoundingClientRect();
  panel.style.top = r.bottom + 8 + "px";
  panel.style.right = window.innerWidth - r.right + "px";
  panel.querySelector("#notifClear").onclick = () => { panel.remove(); qs("#bellBtn .dot")?.remove(); toast("success", "All caught up", "No new notifications."); };
  panel.querySelector("a").onclick = () => panel.remove();
  const off = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) { panel.remove(); document.removeEventListener("mousedown", off); } };
  setTimeout(() => document.addEventListener("mousedown", off), 0);
}

/* ---------------- Router ---------------- */
function currentRoute() { return (location.hash.replace(/^#\/?/, "").split("/")[0]) || ""; }

let mountedPage = null;

function route() {
  const r = currentRoute();
  const page = api.auth.canAdmin ? (OPERATOR_PAGES[r] || notFound) : (MEMBER_PAGES[r] || forbidden);
  const view = qs("#view");
  if (!view) return;
  mountedPage?.unmount?.();
  const ctx = { navigate: (to) => (location.hash = "#/" + to), rerender: route, params: location.hash.split("/").slice(2) };
  view.innerHTML = `<div class="view">${page.render(ctx)}</div>`;
  page.mount && page.mount(qs(".view", view), ctx);
  mountedPage = page;
  // update active nav without full re-render
  qsa(".nav-item").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#/" + r));
  const item = navigation().flatMap((group) => group.items).find((entry) => entry.route === r);
  const title = item ? navLabel(item) : page.title;
  document.title = (title ? title + " · " : "") + "Agentic OS";
  qs("#view").scrollTop = 0;
  window.scrollTo(0, 0);
}

const notFound = { title: "", render: () => `<div class="empty"><div class="empty-ico">${icon("search")}</div><h4>${tr("shell.notFound")}</h4><p>${tr("shell.notFoundText")}</p><a class="btn btn-primary" href="#/">${tr("shell.backHome")}</a></div>` };
const forbidden = { title: "", render: () => `<div class="empty"><div class="empty-ico">${icon("shield")}</div><h4>${tr("shell.adminRequired")}</h4><p>${tr("shell.adminText")}</p><a class="btn btn-primary" href="#/">${tr("shell.backHome")}</a></div>` };

/* ---------------- Bootstrap ---------------- */
async function boot() {
  applyThemeSilent(store.state.settings.theme || "dark");
  await api.detect();
  if (!api.needsAuth) {
    store.setScope(api.auth.user?.id || "local");
    applyThemeSilent(store.state.settings.theme || "dark");
  }
  window.addEventListener("hashchange", route);
  window.addEventListener("aos:locale-change", () => {
    renderShell();
    route();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openCommandPalette(); }
    else if (e.key === "Escape") closeOverlay();
  });
  if (api.needsAuth) return renderLogin();
  syncAuthenticatedProfile();
  if (api.on) {
    try {
      const onboarding = await api.onboarding.get();
      setLocale(onboarding.profile?.locale || getLocale());
      store.set((state) => { state.profile.locale = onboarding.profile?.locale || getLocale(); });
      const forceSetup = new URLSearchParams(location.search).get("setup") === "1";
      if (onboarding.needsOnboarding || forceSetup) return renderOnboarding(onboarding);
    } catch (error) {
      console.warn("[onboarding]", error.message);
    }
  }
  renderShell();
  if (api.auth.canAdmin) mountMilaDock();
  route();
}

function syncAuthenticatedProfile() {
  const user = api.auth.user;
  if (!user?.name) return;
  store.set((state) => {
    state.profile = {
      ...state.profile,
      name: user.name,
      email: user.email || "",
      role: user.role || "User",
      avatar: user.avatar || "",
    };
  });
}

function renderLogin() {
  const app = qs("#app");
  app.removeAttribute("aria-busy");
  const canRegister = api.auth.registration;
  const params = new URLSearchParams(location.search);
  const verifyToken = params.get("verify") || "";
  const resetToken = params.get("reset") || "";
  app.innerHTML = `<div class="login-wrap"><form class="login-card" id="loginForm" data-mode="login">
    <label class="login-language" aria-label="${tr("login.language")}">${icon("chat")}<select id="loginLocale">
      ${SUPPORTED_LOCALES.map(([code, label]) => `<option value="${code}" ${getLocale() === code ? "selected" : ""}>${label}</option>`).join("")}
    </select></label>
    <div class="brand-mark brand-mark-lg">${brandMark()}</div>
    <h1 style="text-align:center;font-size:22px;font-weight:800;letter-spacing:-.02em">Mila</h1>
    <p class="brand-sub">Agentic OS</p>
    <p class="muted" id="loginLead" style="text-align:center;margin:6px 0 18px">${tr("login.lead")}</p>
    ${canRegister ? `<div class="login-tabs" role="tablist"><button type="button" class="active" data-auth-mode="login">${tr("login.signIn")}</button><button type="button" data-auth-mode="register">${tr("login.create")}</button></div>` : ""}
    <div class="field" id="authNameField"><label class="label" for="loginName">${tr("login.name")}</label><input class="input" id="loginName" autocomplete="name"/></div>
    <div class="field" id="authEmailField"><label class="label" for="loginEmail">${tr("login.email")} <span class="muted" id="creatorHint">${tr("login.creatorHint")}</span></label><input class="input" id="loginEmail" type="email" autocomplete="email"/></div>
    <div class="field" id="authPasswordField"><label class="label" for="loginPw" id="passwordLabel">${tr("login.password")}</label><input class="input" id="loginPw" type="password" autocomplete="current-password" minlength="10"/></div>
    <div id="loginErr"></div>
    <button class="btn btn-primary block" id="authSubmit" type="submit">${icon("lock")}<span>${tr("login.signIn")}</span></button>
    <button class="btn btn-ghost block" id="forgotPassword" type="button">${tr("login.forgot")}</button>
    <button class="btn btn-ghost block" id="authBack" type="button" hidden>${tr("login.back")}</button>
  </form></div>`;
  const form = qs("#loginForm");
  qs("#loginLocale").onchange = (event) => {
    setLocale(event.target.value);
    renderLogin();
  };
  const setMode = (mode) => {
    form.dataset.mode = mode;
    form.querySelectorAll("[data-auth-mode]").forEach((button) => button.classList.toggle("active", button.dataset.authMode === mode));
    const login = mode === "login";
    const register = mode === "register";
    const forgot = mode === "forgot";
    const reset = mode === "reset";
    const terminal = mode === "sent" || mode === "verify";
    qs("#authNameField").hidden = !register;
    qs("#authEmailField").hidden = !(login || register || forgot);
    qs("#authPasswordField").hidden = !(login || register || reset);
    qs(".login-tabs")?.toggleAttribute("hidden", !(login || register));
    qs("#forgotPassword").hidden = !login || !api.auth.accountRecovery.deliveryReady;
    qs("#authBack").hidden = login || register || mode === "verify";
    qs("#authSubmit").hidden = terminal;
    qs("#creatorHint").hidden = !login;
    qs("#loginLead").textContent = tr(register ? "login.registerLead" : forgot ? "login.forgotLead" : reset ? "login.resetLead" : mode === "verify" ? "login.verifying" : "login.lead");
    qs("#authSubmit span").textContent = tr(register ? "login.create" : forgot ? "login.sendReset" : reset ? "login.resetPassword" : "login.signIn");
    qs("#passwordLabel").textContent = tr(reset ? "login.newPassword" : "login.password");
    qs("#loginPw").autocomplete = register || reset ? "new-password" : "current-password";
    qs("#loginErr").innerHTML = "";
    if (!terminal) (register ? qs("#loginName") : reset ? qs("#loginPw") : qs("#loginEmail")).focus();
  };
  form.querySelectorAll("[data-auth-mode]").forEach((button) => button.onclick = () => setMode(button.dataset.authMode));
  qs("#forgotPassword").onclick = () => setMode("forgot");
  qs("#authBack").onclick = () => setMode("login");
  setMode("login");
  qs("#loginEmail").focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = qs("#authSubmit"); btn.classList.add("loading");
    const body = { email: qs("#loginEmail").value.trim(), password: qs("#loginPw").value };
    try {
      if (form.dataset.mode === "forgot") {
        await api.auth.forgotPassword(body.email);
        setMode("sent");
        qs("#loginLead").textContent = tr("login.emailSentText");
        qs("#loginErr").innerHTML = `<div class="alert success"><div class="a-body"><div class="a-title">${tr("login.emailSent")}</div></div></div>`;
        return;
      }
      if (form.dataset.mode === "reset") {
        await api.auth.resetPassword(resetToken, body.password);
        setMode("sent");
        qs("#loginLead").textContent = tr("login.passwordReset");
        return;
      }
      if (form.dataset.mode === "register") {
        const result = await api.auth.register({ ...body, name: qs("#loginName").value.trim() });
        if (result.verificationRequired) {
          setMode("sent");
          qs("#loginLead").textContent = tr("login.verificationSent");
          return;
        }
      } else await api.auth.login(body);
      location.reload();
    } catch (err) {
      qs("#loginErr").innerHTML = `<div class="field-error" style="margin-bottom:10px">${esc(err.message || tr("login.failed"))}</div>${err.code === "email_unverified" ? `<button class="btn btn-outline block" id="resendVerification" type="button">${tr("login.resend")}</button>` : ""}`;
      const resend = qs("#resendVerification");
      if (resend) resend.onclick = async () => { await api.auth.resendVerification(body.email); setMode("sent"); qs("#loginLead").textContent = tr("login.verificationSent"); };
      btn.classList.remove("loading");
      if (!qs("#loginPw").hidden) qs("#loginPw").focus();
    }
  };
  if (resetToken) setMode("reset");
  if (verifyToken) {
    setMode("verify");
    api.auth.verifyEmail(verifyToken).then(() => {
      qs("#loginLead").textContent = tr("login.emailVerified");
      qs("#authBack").hidden = false;
      history.replaceState({}, "", location.pathname);
    }).catch((error) => {
      qs("#loginErr").innerHTML = `<div class="field-error">${esc(error.message)}</div>`;
      qs("#authBack").hidden = false;
    });
  }
}
function applyThemeSilent(t) { document.documentElement.setAttribute("data-theme", t); }

boot();
