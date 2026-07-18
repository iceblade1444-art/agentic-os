import { store } from "./store.js";
import { icon } from "./icons.js";
import { api } from "./api.js";
import { el, qs, qsa, agentIcon, initials, esc, closeOverlay, toast } from "./ui.js";
import { mountMilaDock } from "./mila-dock.js";

import dashboard from "./pages/dashboard.js";
import agents from "./pages/agents.js";
import missions from "./pages/missions.js";
import hermes from "./pages/hermes.js";
import claude from "./pages/claude-code.js";
import mila from "./pages/mila.js";
import chat from "./pages/chat.js";
import workflows from "./pages/workflows.js";
import settings from "./pages/settings.js";
import components from "./pages/components.js";
import * as misc from "./pages/misc.js";

/* ---------------- Navigation config ---------------- */
const NAV = [
  { group: null, items: [
    { route: "", icon: "home", label: "Home" },
    { route: "missions", icon: "rocket", label: "Missions" },
    { route: "hermes", icon: "brain", label: "Hermes Control" },
    { route: "claude", icon: "code", label: "Claude Workspace" },
    { route: "mila", icon: "mic", label: "Mila Live" },
    { route: "agents", icon: "agents", label: "Agents" },
    { route: "chat", icon: "chat", label: "Chat" },
    { route: "kanban", icon: "workflow", label: "Kanban" },
    { route: "tools", icon: "tools", label: "Tools" },
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

const PAGES = {
  "": dashboard, agents, missions, hermes, claude, mila, chat, kanban: workflows, workflows, settings, components,
  tools: misc.tools, knowledge: misc.knowledge, memory: misc.memory,
  mcp: misc.mcp, integrations: misc.integrations, observability: misc.observability,
  guardrails: misc.guardrails, secrets: misc.secrets, evaluations: misc.evaluations,
};
const ADMIN_ROUTES = new Set(["mcp", "integrations", "secrets"]);

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
  const groups = NAV.map((g) => `
    ${g.group ? `<div class="nav-label">${g.group}</div>` : ""}
    <div class="nav-group">
      ${g.items.filter((it) => api.auth.canAdmin || !ADMIN_ROUTES.has(it.route)).map((it) => `
        <a class="nav-item ${it.route === cur ? "active" : ""}" href="#/${it.route}">
          ${icon(it.icon)}<span>${it.label}</span>
          ${it.route === "agents" ? `<span class="nav-tag">5</span>` : ""}
        </a>`).join("")}
    </div>`).join("");
  return `<aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="brand-mark">${icon("rocket")}</div>
      <div class="brand-name">Agentic OS</div>
      <span class="brand-badge">v1.0</span>
    </div>
    ${groups}
    <div class="sidebar-foot">
      <div class="user-chip">
        <div class="avatar" style="width:34px;height:34px">${p.avatar ? `<img src="${p.avatar}"/>` : initials(p.name)}</div>
        <div class="stack"><span class="u-name">${esc(p.name)}</span><span class="u-mail">${esc(p.email || (p.role === "Creator" ? "Project owner" : p.role || "User"))}</span></div>
        <button class="icon-btn" id="user-menu">${icon("more")}</button>
      </div>
    </div>
  </aside>`;
}

function topbarHTML() {
  const t = store.state.settings.theme;
  return `<header class="topbar">
    <button class="icon-btn menu-toggle" id="mtoggle">${icon("grid")}</button>
    <div class="search"><span>${icon("search")}</span><input id="globalSearch" placeholder="Search agents, tools, docs…"/><kbd>⌘K</kbd></div>
    <div class="topbar-actions">
      ${api.on ? `<span class="badge success tip" data-tip="Backend connected — real MCP, integrations & LLM"><span class="dot"></span>Live</span>` : `<span class="badge neutral tip" data-tip="No backend — demo mode (start the Node server)">Demo</span>`}
      <button class="icon-btn" id="themeBtn" title="Toggle theme">${icon(t === "dark" ? "sun" : "moon")}</button>
      <button class="icon-btn" title="Help">${icon("help")}</button>
      <button class="icon-btn" id="bellBtn" title="Notifications" style="position:relative">${icon("bell")}<span class="dot"></span></button>
      ${api.auth.canWrite ? `<a class="btn btn-primary" href="#/kanban/new" id="newAgentTop">${icon("plus")}<span>New task</span></a>` : ""}
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
    { text: "Profile", icon: "user", onClick: () => (location.hash = "#/settings") },
    { text: "Settings", icon: "settings", onClick: () => (location.hash = "#/settings") },
    { text: "Component library", icon: "layers", onClick: () => (location.hash = "#/components") },
    { sep: true },
    { text: "Sign out", icon: "logout", danger: true, onClick: async () => { if (api.health?.auth) { try { await api.auth.logout(); } catch {} location.reload(); } else m.toast("info", "Signed out (demo)"); } },
  ]));
}

/* ---------------- Command palette (⌘K) ---------------- */
function buildCommands() {
  const t = store.state.settings.theme;
  const cmds = [];
  NAV.forEach((g) => g.items.forEach((it) => cmds.push({ group: "Pages", icon: it.icon, text: it.label, hint: "#/" + (it.route || ""), run: () => (location.hash = "#/" + it.route) })));
  cmds.push({ group: "Pages", icon: "layers", text: "Component Library", hint: "#/components", run: () => (location.hash = "#/components") });
  [
    ["Hermes", "Primary orchestrator", "brain", "default"], ["Scout", "Research", "search", "scout"],
    ["Scribe", "Writing", "edit", "scribe"], ["Reach", "Growth", "up", "reach"], ["Dev", "Engineering", "code", "dev"],
  ].forEach(([name, role, agentIcon, profile]) => cmds.push({ group: "Agents", icon: agentIcon, text: name, hint: role, run: () => (location.hash = `#/kanban/new/${profile}`) }));
  cmds.push({ group: "Actions", icon: "plus", text: "New Kanban task", run: () => (location.hash = "#/kanban/new") });
  cmds.push({ group: "Actions", icon: "chat", text: "New chat", run: () => (location.hash = "#/chat") });
  cmds.push({ group: "Actions", icon: t === "dark" ? "sun" : "moon", text: "Toggle theme", run: toggleTheme });
  cmds.push({ group: "Actions", icon: "settings", text: "Open settings", run: () => (location.hash = "#/settings") });
  return cmds;
}
function openCommandPalette() {
  if (qs(".cmdk")) return;
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  const cmds = buildCommands();
  const root = qs("#overlay-root");
  const scrim = el(`<div class="scrim"></div>`);
  const box = el(`<div class="cmdk" role="dialog" aria-modal="true">
    <div class="cmdk-search">${icon("search")}<input id="cmdkInput" placeholder="Search pages, agents, actions…" autocomplete="off"/></div>
    <div class="cmdk-list" id="cmdkList"></div>
    <div class="cmdk-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> select</span><span><kbd>esc</kbd> close</span></div>
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
    if (!filtered.length) html = `<div class="cmdk-group">No results</div>`;
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
  const page = (!api.auth.canAdmin && ADMIN_ROUTES.has(r)) ? forbidden : (PAGES[r] || notFound);
  const view = qs("#view");
  if (!view) return;
  mountedPage?.unmount?.();
  const ctx = { navigate: (to) => (location.hash = "#/" + to), rerender: route, params: location.hash.split("/").slice(2) };
  view.innerHTML = `<div class="view">${page.render(ctx)}</div>`;
  page.mount && page.mount(qs(".view", view), ctx);
  mountedPage = page;
  // update active nav without full re-render
  qsa(".nav-item").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#/" + r));
  document.title = (page.title ? page.title + " · " : "") + "Agentic OS";
  qs("#view").scrollTop = 0;
  window.scrollTo(0, 0);
}

const notFound = { title: "Not found", render: () => `<div class="empty"><div class="empty-ico">${icon("search")}</div><h4>Page not found</h4><p>The page you’re looking for doesn’t exist.</p><a class="btn btn-primary" href="#/">Back home</a></div>` };
const forbidden = { title: "Access denied", render: () => `<div class="empty"><div class="empty-ico">${icon("shield")}</div><h4>Admin access required</h4><p>This system area is available to Creator and Admin accounts.</p><a class="btn btn-primary" href="#/">Back home</a></div>` };

/* ---------------- Bootstrap ---------------- */
async function boot() {
  applyThemeSilent(store.state.settings.theme || "dark");
  await api.detect();
  if (!api.needsAuth) {
    store.setScope(api.auth.user?.id || "local");
    applyThemeSilent(store.state.settings.theme || "dark");
  }
  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openCommandPalette(); }
    else if (e.key === "Escape") closeOverlay();
  });
  if (api.needsAuth) return renderLogin();
  syncAuthenticatedProfile();
  renderShell();
  mountMilaDock();
  route();
}

function syncAuthenticatedProfile() {
  const user = api.auth.user;
  if (!user?.name) return;
  store.set((state) => {
    state.profile = {
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
  app.innerHTML = `<div class="login-wrap"><form class="login-card" id="loginForm" data-mode="login">
    <div class="brand-mark" style="width:48px;height:48px;margin:0 auto 14px">${icon("rocket")}</div>
    <h1 style="text-align:center;font-size:22px;font-weight:800;letter-spacing:-.02em">Agentic OS</h1>
    <p class="muted" id="loginLead" style="text-align:center;margin:6px 0 18px">Sign in to your workspace.</p>
    ${canRegister ? `<div class="login-tabs" role="tablist"><button type="button" class="active" data-auth-mode="login">Sign in</button><button type="button" data-auth-mode="register">Create account</button></div>` : ""}
    <div class="field auth-register-only"><label class="label" for="loginName">Name</label><input class="input" id="loginName" autocomplete="name"/></div>
    <div class="field"><label class="label" for="loginEmail">Email <span class="auth-login-only muted">(leave blank for Creator)</span></label><input class="input" id="loginEmail" type="email" autocomplete="email"/></div>
    <div class="field"><label class="label" for="loginPw">Password</label><input class="input" id="loginPw" type="password" autocomplete="current-password" minlength="10"/></div>
    <div id="loginErr"></div>
    <button class="btn btn-primary block" id="authSubmit" type="submit">${icon("lock")}<span>Sign in</span></button>
  </form></div>`;
  const form = qs("#loginForm");
  const setMode = (mode) => {
    form.dataset.mode = mode;
    form.querySelectorAll("[data-auth-mode]").forEach((button) => button.classList.toggle("active", button.dataset.authMode === mode));
    qs("#loginLead").textContent = mode === "register" ? "Create a Member account for this workspace." : "Sign in to your workspace.";
    qs("#authSubmit span").textContent = mode === "register" ? "Create account" : "Sign in";
    qs("#loginPw").autocomplete = mode === "register" ? "new-password" : "current-password";
    qs("#loginErr").innerHTML = "";
    (mode === "register" ? qs("#loginName") : qs("#loginEmail")).focus();
  };
  form.querySelectorAll("[data-auth-mode]").forEach((button) => button.onclick = () => setMode(button.dataset.authMode));
  qs("#loginEmail").focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = qs("#authSubmit"); btn.classList.add("loading");
    const body = { email: qs("#loginEmail").value.trim(), password: qs("#loginPw").value };
    try {
      if (form.dataset.mode === "register") await api.auth.register({ ...body, name: qs("#loginName").value.trim() });
      else await api.auth.login(body);
      location.reload();
    } catch (err) { qs("#loginErr").innerHTML = `<div class="field-error" style="margin-bottom:10px">${esc(err.message || "Login failed")}</div>`; btn.classList.remove("loading"); qs("#loginPw").focus(); }
  };
}
function applyThemeSilent(t) { document.documentElement.setAttribute("data-theme", t); }

boot();
