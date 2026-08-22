import { store, timeAgo } from "./store.js";
import { brandMark } from "./brand.js";
import { icon } from "./icons.js";
import { api } from "./api.js";
import { el, qs, qsa, agentIcon, initials, esc, closeOverlay, toast } from "./ui.js";
import { mountMilaDock } from "./mila-dock.js";
import { renderOnboarding } from "./onboarding.js";
import { SUPPORTED_LOCALES, getLocale, setLocale, t as tr } from "./i18n.js";
import { saveProfileLocale } from "./profile-locale.js";
import { authenticate as telegramAuthenticate, inTelegram, mountTelegramBridge } from "./telegram-miniapp.js";

import dashboard from "./pages/dashboard.js";
import agents from "./pages/agents.js";
import missions from "./pages/missions.js";
import hermes from "./pages/hermes.js";
import claude from "./pages/claude-code.js";
import mila from "./pages/mila.js";
import chat from "./pages/messenger.js";
import workflows from "./pages/workflows.js";
import settings from "./pages/settings.js";
import speech from "./pages/speech.js";
import routines from "./pages/routines.js";
import components from "./pages/components.js";
import personal from "./pages/personal.js";
import erp from "./pages/erp.js";
import { analytics, design, media } from "./pages/studio.js";
import { memberHome, memberNotes, memberTasks } from "./pages/member.js";
import memberInbox from "./pages/member-inbox.js";
import testApps from "./pages/test-apps.js";
import * as misc from "./pages/misc.js";

// A Telegram web app is opened with ?start=<route>: its init data goes into the
// hash fragment, which would overwrite any route we put there.
(function applyStartRoute() {
  const start = new URLSearchParams(location.search).get("start");
  if (!start) return;
  const route = start.replace(/[^a-z0-9/-]/gi, "");
  if (route && !location.hash.startsWith(`#/${route}`)) location.hash = `#/${route}`;
})();

/* ---------------- Navigation config ----------------

   Twenty-six destinations in one flat list, identical for every operator, with
   nothing marking which of them needed attention. The first act of a session
   was scanning it.

   Six now, in a rail that never changes, each opening a column of its own
   children. Nothing was removed — every route below had a home in the old list
   and has one here, and the command palette still reaches all of them by name.
   Settings moved to the avatar menu, where every other product keeps it.

   MILA is not one of the six. She is the orb at the foot of the rail: an
   assistant is not a destination you navigate to and leave. */
const OPERATOR_SECTIONS = [
  { id: "today", icon: "home", bottom: true, children: [
    { route: "", navKey: "sec.overview" },
    { route: "personal" },
  ]},
  { id: "work", icon: "workflow", bottom: true, children: [
    { route: "kanban" },
    { route: "missions" },
    { route: "my-tasks" },
    { route: "my-notes" },
    { route: "routines" },
  ]},
  { id: "agents", icon: "agents", children: [
    { route: "agents" },
    { route: "hermes" },
    { route: "claude" },
    { route: "tools" },
    { route: "mcp" },
    { route: "evaluations" },
    { route: "guardrails" },
    { route: "observability" },
    { route: "test-apps" },
  ]},
  { id: "business", icon: "activity", bottom: true, children: [
    { route: "erp" },
    { route: "analytics" },
    { route: "design" },
    { route: "media" },
    { route: "speech" },
  ]},
  { id: "library", icon: "knowledge", children: [
    { route: "knowledge" },
    { route: "memory" },
    { route: "integrations" },
    { route: "secrets" },
  ]},
  { id: "chat", icon: "chat", bottom: true, children: [{ route: "chat" }] },
];

// ERP is the landing page for Member: it opens straight to the live business
// snapshot instead of a personal dashboard that only duplicates Personal's brief.
const MEMBER_SECTIONS = [
  { id: "business", icon: "activity", bottom: true, children: [{ route: "", navKey: "erp" }] },
  { id: "today", icon: "home", bottom: true, children: [{ route: "personal" }] },
  { id: "work", icon: "workflow", children: [
    { route: "my-tasks" },
    { route: "my-notes" },
  ]},
  { id: "inbox", icon: "inbox", navKey: "inbox", bottom: true, children: [{ route: "inbox" }] },
  { id: "chat", icon: "chat", bottom: true, children: [{ route: "chat" }] },
];

// Design = the member surface plus the creative studio. No agent controls, no
// analytics, no operate group.
const DESIGN_SECTIONS = [
  { id: "today", icon: "home", bottom: true, children: [
    { route: "", navKey: "sec.overview" },
    { route: "personal" },
  ]},
  { id: "work", icon: "workflow", bottom: true, children: [
    { route: "my-tasks" },
    { route: "my-notes" },
  ]},
  { id: "studio", icon: "image", bottom: true, children: [
    { route: "design" },
    { route: "media" },
    { route: "knowledge" },
  ]},
  { id: "business", icon: "activity", children: [{ route: "erp" }] },
  { id: "inbox", icon: "inbox", navKey: "inbox", children: [{ route: "inbox" }] },
  { id: "chat", icon: "chat", bottom: true, children: [{ route: "chat" }] },
];

const OPERATOR_PAGES = {
  "": dashboard, personal, agents, missions, hermes, claude, mila, speech, chat, kanban: workflows, workflows, routines, settings, components,
  "my-tasks": memberTasks, "my-notes": memberNotes,
  tools: misc.tools, knowledge: misc.knowledge, memory: misc.memory,
  mcp: misc.mcp, integrations: misc.integrations, observability: misc.observability,
  guardrails: misc.guardrails, secrets: misc.secrets, evaluations: misc.evaluations,
  design, media, analytics,
  erp, "test-apps": testApps,
};
const MEMBER_PAGES = { "": erp, personal, chat, mila, inbox: memberInbox, "my-tasks": memberTasks, "my-notes": memberNotes, settings, erp };
// Design keeps the original personal dashboard as its landing page and has no Mila
// Live nav entry — both stay scoped to Member only, undoing what the spread inherits.
const DESIGN_PAGES = { ...MEMBER_PAGES, "": memberHome, mila: undefined, design, media, knowledge: misc.knowledge };
const sections = () => api.auth.canAdmin ? OPERATOR_SECTIONS : api.auth.canStudio ? DESIGN_SECTIONS : MEMBER_SECTIONS;
const pages = () => api.auth.canAdmin ? OPERATOR_PAGES : api.auth.canStudio ? DESIGN_PAGES : MEMBER_PAGES;
const NAV_KEYS = {
  "": "home", personal: "personal", missions: "missions", hermes: "hermes", claude: "claude",
  mila: "mila", speech: "speech", agents: "agents", chat: "chat", kanban: "kanban",
  routines: "routines", tools: "tools", knowledge: "knowledge", memory: "memory", mcp: "mcp",
  integrations: "integrations", evaluations: "evaluations", observability: "observability",
  guardrails: "guardrails", secrets: "secrets", settings: "settings", "my-tasks": "myTasks",
  "my-notes": "myNotes",
  inbox: "inbox", "test-apps": "testApps",
  design: "design", media: "media", analytics: "analytics", erp: "erp",
};
const navLabel = (item) => tr(`nav.${item.navKey || NAV_KEYS[item.route] || item.route}`);
const sectionLabel = (section) => tr(`nav.sec.${section.id}`);
// Flat list of every reachable item, which is what the command palette and the
// active-item bookkeeping still want.
const navItems = () => sections().flatMap((section) => section.children.map((child) => ({ ...child, section })));
const sectionForRoute = (route) => sections().find((section) => section.children.some((child) => child.route === route));

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
  const all = sections();
  const active = sectionForRoute(cur) || all[0];

  const rail = all.map((section) => `
    <a class="rail-item ${section === active ? "active" : ""}" href="#/${section.children[0].route}"
       data-section="${section.id}" aria-label="${sectionLabel(section)}"
       ${section === active ? 'aria-current="true"' : ""}>
      ${icon(section.icon)}<span>${sectionLabel(section)}</span>
      ${section.id === "today" ? `<span class="rail-count" id="railNeeds" hidden></span>` : ""}
    </a>`).join("");

  // Only the active section's children. The other five columns exist, they are
  // one click away, and none of them are on screen competing for the eye.
  const children = active.children.map((child) => `
    <a class="nav-item ${child.route === cur ? "active" : ""}" href="#/${child.route}">
      <span>${navLabel(child)}</span>
      ${child.route === "agents" ? `<span class="nav-tag">5</span>` : ""}
    </a>`).join("");

  return `<aside class="sidebar" id="sidebar">
    <nav class="rail" aria-label="${tr("shell.sections")}">
      <a class="rail-brand" href="#/" aria-label="Mila · Agentic OS"></a>
      ${rail}
      <div class="rail-foot">
        ${pages().mila ? `<a class="rail-orb" href="#/mila" aria-label="MILA"></a>` : ""}
        <button class="icon-btn" id="user-menu" aria-label="${esc(p.name)}">
          <span class="avatar" style="width:30px;height:30px">${p.avatar ? `<img src="${p.avatar}"/>` : initials(p.name)}</span>
        </button>
      </div>
    </nav>
    <div class="sectionnav" id="sectionNav">
      <div class="sectionnav-head">
        <a class="brand-lockup" href="#/" aria-label="Mila · Agentic OS"></a>
        <span class="brand-badge">v1.0</span>
      </div>
      <div class="sectionnav-title">${sectionLabel(active)}</div>
      <div class="nav-group">${children}</div>
      <div class="sidebar-foot">
        <div class="user-chip">
          <div class="avatar" style="width:34px;height:34px">${p.avatar ? `<img src="${p.avatar}"/>` : initials(p.name)}</div>
          <div class="stack"><span class="u-name">${esc(p.name)}</span><span class="u-mail">${esc(p.email || (p.role === "Creator" ? tr("shell.projectOwner") : p.role || "User"))}</span></div>
          <button class="icon-btn" id="user-menu-wide">${icon("more")}</button>
        </div>
      </div>
    </div>
  </aside>`;
}

function topbarHTML() {
  const theme = store.state.settings.theme;
  const member = !api.auth.canAdmin;
  return `<header class="topbar">
    <button class="icon-btn menu-toggle" id="mtoggle" aria-label="${tr("shell.menu")}" aria-expanded="false" aria-controls="sidebar">${icon("grid")}</button>
    <div class="search"><span>${icon("search")}</span><input id="globalSearch" placeholder="${tr(member ? "shell.searchMember" : "shell.searchOperator")}"/><kbd>⌘K</kbd></div>
    <button class="icon-btn search-compact" id="globalSearchCompact" aria-label="${tr(member ? "shell.searchMember" : "shell.searchOperator")}">${icon("search")}</button>
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

/* ---------------- Bottom tabs ----------------
   Below the tablet breakpoint the drawer was the only navigation there was, and
   a drawer is a thing you have to know is there. Four sections and the orb sit
   where a thumb already rests; the rest stays in the drawer, which the
   hamburger still opens.

   Same four, same order, same words as the Flutter app's bar — a floor manager
   who learns one knows the other. */
function tabbarHTML() {
  const cur = currentRoute();
  const bottom = sections().filter((section) => section.bottom).slice(0, 4);
  if (bottom.length < 2) return "";
  const active = sectionForRoute(cur);
  const tab = (section) => `
    <a class="tab-item ${section === active ? "active" : ""}" href="#/${section.children[0].route}"
       data-section="${section.id}" ${section === active ? 'aria-current="page"' : ""}>
      ${icon(section.icon)}<span>${sectionLabel(section)}</span>
      ${section.bottom && section.id === "today" ? `<span class="tab-count" id="tabNeeds" hidden></span>` : ""}
    </a>`;
  const orb = pages().mila
    ? `<a class="tab-orb" href="#/mila" aria-label="MILA"></a>`
    : `<span class="tab-orb-spacer"></span>`;
  // The orb takes the middle slot, so the four sections split two and two
  // around it rather than being pushed to one side.
  return `<nav class="tabbar" id="tabbar" aria-label="${tr("shell.sections")}">
    ${bottom.slice(0, 2).map(tab).join("")}
    ${orb}
    ${bottom.slice(2).map(tab).join("")}
  </nav>`;
}

export function renderShell() {
  const app = qs("#app");
  app.removeAttribute("aria-busy");
  app.innerHTML = `<div class="layout">${sidebarHTML()}<div class="main">${topbarHTML()}<div id="view"></div>${tabbarHTML()}</div></div>`;
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
  wireNavDrawer();
  const gs = qs("#globalSearch");
  if (gs) { gs.readOnly = true; gs.addEventListener("focus", openCommandPalette); gs.addEventListener("click", openCommandPalette); }
  const gsc = qs("#globalSearchCompact");
  if (gsc) gsc.onclick = openCommandPalette;
  const bell = qs("#bellBtn");
  if (bell) bell.onclick = () => openNotifications(bell);
  // The rail carries the avatar; the section column carries the full chip. Both
  // open the same menu, which is now also where Settings lives.
  for (const id of ["#user-menu", "#user-menu-wide"]) {
    const um = qs(id);
    if (!um) continue;
    um.onclick = () => import("./ui.js").then((m) => m.openMenu(um, [
      { label: store.state.profile.name },
      { text: tr("nav.personal"), icon: "user", onClick: () => (location.hash = "#/personal") },
      { text: tr("shell.settings"), icon: "settings", onClick: () => (location.hash = "#/settings") },
      { text: `${tr("shell.density")}: ${tr(isCompact() ? "shell.densityCompact" : "shell.densityComfortable")}`,
        icon: "layers", onClick: toggleDensity },
      ...(api.auth.canAdmin ? [{ text: tr("shell.componentLibrary"), icon: "layers", onClick: () => (location.hash = "#/components") }] : []),
      { sep: true },
      { text: tr("shell.signOut"), icon: "logout", danger: true, onClick: async () => { if (api.health?.auth) { try { await api.auth.logout(); } catch {} location.reload(); } else m.toast("info", tr("shell.signOut")); } },
    ], { align: "right", placement: "top" }));
  }
  refreshNeedsBadge();
}

/* ---------------- Density ----------------
   The 9px type came from trying to fit a dense table into a comfortable
   layout. Splitting the two lets each be itself: Comfortable is the default,
   Compact tightens rows and gutters, and neither goes below the 12px floor.
   body.compact already existed and was never reachable from anywhere. */
// settings.compact has been in the store since the beginning and body.compact
// has been in the stylesheet since the beginning. Nothing ever set the one or
// read the other, so the preference existed and could not be expressed.
const isCompact = () => store.state.settings.compact === true;
function applyDensity() {
  document.body.classList.toggle("compact", isCompact());
}
function toggleDensity() {
  store.set((state) => { state.settings.compact = !isCompact(); });
  applyDensity();
}

/* ---------------- Navigation drawer ----------------
   Below 900px the sidebar leaves the flow and slides over the page. It used to
   do only that: no scrim, so nothing said the page behind had gone inert and
   there was nothing to tap to dismiss; no Escape; no focus containment, so a
   keyboard or screen-reader user tabbed straight out of the open drawer into
   a page they could not see; and the document kept scrolling underneath.

   The drawer is only ever modal at that width. Above it the sidebar is an
   ordinary column, and every behaviour here has to stay out of the way. */
const DRAWER_MEDIA = "(max-width: 900px)";
const isDrawer = () => window.matchMedia(DRAWER_MEDIA).matches;
const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

let drawerTeardown = null;

function closeNav() {
  const sidebar = qs("#sidebar");
  const scrim = qs("#navScrim");
  const toggle = qs("#mtoggle");
  sidebar?.classList.remove("open");
  scrim?.classList.remove("open");
  sidebar?.setAttribute("aria-hidden", isDrawer() ? "true" : "false");
  toggle?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("nav-open");
  drawerTeardown?.();
  drawerTeardown = null;
  if (isDrawer()) toggle?.focus();
}

function openNav() {
  const sidebar = qs("#sidebar");
  const scrim = qs("#navScrim");
  if (!sidebar || !scrim) return;
  sidebar.classList.add("open");
  scrim.classList.add("open");
  sidebar.setAttribute("aria-hidden", "false");
  qs("#mtoggle")?.setAttribute("aria-expanded", "true");
  // The page behind must not scroll under the drawer.
  document.body.classList.add("nav-open");

  const onKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeNav(); return; }
    if (event.key !== "Tab") return;
    const stops = [...sidebar.querySelectorAll(FOCUSABLE)].filter((node) => node.offsetParent !== null);
    if (!stops.length) return;
    const [first, last] = [stops[0], stops[stops.length - 1]];
    // Wrap at both ends, and pull focus back in if it has already escaped.
    if (!sidebar.contains(document.activeElement)) { event.preventDefault(); first.focus(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", onKey, true);
  drawerTeardown = () => document.removeEventListener("keydown", onKey, true);

  sidebar.querySelector(FOCUSABLE)?.focus();
}

// Between 900 and 1280 there is room for the rail but not for the rail plus a
// section column plus a workspace. The column becomes a flyout the rail opens —
// on hover for a mouse, on focus for a keyboard, and it closes as soon as a
// destination is chosen.
function wireSectionFlyout(sidebar) {
  const narrow = window.matchMedia("(max-width: 1280px) and (min-width: 901px)");
  const expand = () => { if (narrow.matches) sidebar.classList.add("expanded"); };
  const collapse = () => sidebar.classList.remove("expanded");
  sidebar.addEventListener("mouseenter", expand);
  sidebar.addEventListener("mouseleave", collapse);
  sidebar.addEventListener("focusin", expand);
  sidebar.addEventListener("focusout", (event) => {
    if (!sidebar.contains(event.relatedTarget)) collapse();
  });
  qsa(".nav-item", sidebar).forEach((link) => link.addEventListener("click", collapse));
  narrow.addEventListener("change", collapse);
}

function wireNavDrawer() {
  const sidebar = qs("#sidebar");
  if (!sidebar) return;
  wireSectionFlyout(sidebar);

  // The scrim lives beside the sidebar rather than inside it, so a tap on the
  // page area is a tap on the scrim and not on whatever sits underneath.
  let scrim = qs("#navScrim");
  if (!scrim) {
    scrim = el(`<div class="nav-scrim" id="navScrim" hidden></div>`);
    sidebar.after(scrim);
  }
  scrim.hidden = false;
  scrim.onclick = closeNav;

  const toggle = qs("#mtoggle");
  if (toggle) toggle.onclick = () => (sidebar.classList.contains("open") ? closeNav() : openNav());
  qsa(".nav-item, .rail-item").forEach((link) => link.addEventListener("click", () => { if (isDrawer()) closeNav(); }));

  // Drag the drawer off to the left. Horizontal intent is decided once, on the
  // first few pixels, so a vertical scroll of a long nav list is never stolen.
  let startX = 0, startY = 0, dragging = null;
  sidebar.addEventListener("touchstart", (event) => {
    if (!isDrawer() || !sidebar.classList.contains("open")) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    dragging = null;
  }, { passive: true });
  sidebar.addEventListener("touchmove", (event) => {
    if (!isDrawer() || !sidebar.classList.contains("open") || startX === 0) return;
    const dx = event.touches[0].clientX - startX;
    const dy = event.touches[0].clientY - startY;
    if (dragging === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      dragging = Math.abs(dx) > Math.abs(dy) && dx < 0;
    }
    if (!dragging) return;
    sidebar.style.transition = "none";
    sidebar.style.transform = `translateX(${Math.min(0, dx)}px)`;
  }, { passive: true });
  const endDrag = (event) => {
    if (!dragging) { startX = 0; return; }
    const dx = (event.changedTouches?.[0]?.clientX ?? startX) - startX;
    sidebar.style.transition = "";
    sidebar.style.transform = "";
    if (dx < -60) closeNav();
    dragging = null; startX = 0;
  };
  sidebar.addEventListener("touchend", endDrag, { passive: true });
  sidebar.addEventListener("touchcancel", endDrag, { passive: true });

  // Resizing past the breakpoint with the drawer open would otherwise leave the
  // scrim and the scroll lock on a layout that no longer has a drawer.
  const media = window.matchMedia(DRAWER_MEDIA);
  const sync = () => {
    if (!media.matches) {
      scrim.classList.remove("open");
      sidebar.classList.remove("open");
      document.body.classList.remove("nav-open");
      drawerTeardown?.();
      drawerTeardown = null;
    }
    sidebar.setAttribute("aria-hidden", media.matches && !sidebar.classList.contains("open") ? "true" : "false");
  };
  media.addEventListener("change", sync);
  sync();
}

/* ---------------- Command palette (⌘K) ---------------- */
function buildCommands() {
  const theme = store.state.settings.theme;
  const cmds = [];
  // Still every destination by name, grouped by the section it now lives in —
  // the palette is what keeps a six-item rail from hiding anything.
  navItems().forEach((it) => cmds.push({
    group: sectionLabel(it.section), icon: it.section.icon, text: navLabel(it),
    hint: "#/" + (it.route || ""), run: () => (location.hash = "#/" + it.route),
  }));
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
// The bell used to render four hardcoded English strings — "Agent task
// completed", "Rate limit approaching" — under a dot that was always lit. It
// had shipped, and it was wired to nothing. The inbox behind it is the same one
// that already feeds push and Telegram; the data was there the whole time.
const NEEDS_TONE = { blocked: "error", waiting: "warning", overdue: "warning", attention: "info" };

async function openNotifications(anchor) {
  if (qs(".notif")) { qs(".notif").remove(); return; }
  const panel = el(`<div class="notif">
    <div class="notif-head"><span class="fw-700">${tr("shell.notifications")}</span><div class="spacer"></div></div>
    <div class="notif-body"><div class="notif-item"><span class="cell-sub">${tr("needs.loading")}</span></div></div>
  </div>`);
  document.body.appendChild(panel);
  const box = anchor.getBoundingClientRect();
  panel.style.top = `${box.bottom + 8}px`;
  panel.style.right = `${window.innerWidth - box.right}px`;
  const off = (event) => {
    if (!panel.contains(event.target) && !anchor.contains(event.target)) {
      panel.remove();
      document.removeEventListener("mousedown", off);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", off), 0);

  let queue = null;
  try { queue = await api.needsYou(); } catch { /* shown as unavailable below */ }
  const body = panel.querySelector(".notif-body");
  if (!body) return;
  if (!queue) {
    body.innerHTML = `<div class="notif-item"><span class="cell-sub">${tr("needs.error")}</span></div>`;
    return;
  }
  if (!queue.items.length) {
    body.innerHTML = `<div class="notif-item"><span class="cell-sub">${tr("needs.empty")}</span></div>`;
    qs("#bellBtn .dot")?.remove();
    return;
  }
  body.innerHTML = queue.items.slice(0, 8).map((item) => `
    <a class="notif-item" href="#/${esc(item.route || "")}">
      <span class="notif-dot ${NEEDS_TONE[item.severity] || "info"}"></span>
      <div class="stack" style="min-width:0">
        <span class="fw-600 text-sm">${esc(item.title)}</span>
        <span class="cell-sub">${esc(tr(`needs.kind.${item.kind}`))}${item.detail ? ` · ${esc(item.detail)}` : ""}</span>
      </div>
      <div class="spacer"></div>
      <span class="dim nowrap" style="font-size:12px">${item.since ? esc(timeAgo(new Date(item.since).getTime())) : ""}</span>
    </a>`).join("");
  panel.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => panel.remove()));
}

// The rail badge, and the bell's dot. One request, both readers.
export async function refreshNeedsBadge() {
  const badges = [["#railNeeds", "rail-count"], ["#tabNeeds", "tab-count"]]
    .map(([id, cls]) => [qs(id), cls]).filter(([node]) => node);
  const dot = qs("#bellBtn .dot");
  if (!badges.length && !dot) return;
  let queue = null;
  try { queue = await api.needsYou(); } catch { return; }
  const total = queue?.total || 0;
  const tone = NEEDS_TONE[queue?.severity] || "info";
  for (const [badge, cls] of badges) {
    badge.textContent = total > 99 ? "99+" : String(total);
    badge.hidden = total === 0;
    badge.className = `${cls} ${tone}`;
  }
  // No dot when there is nothing. The old one was painted on.
  if (dot) dot.hidden = total === 0;
}

/* ---------------- Router ---------------- */
function currentRoute() { return (location.hash.replace(/^#\/?/, "").split("/")[0]) || ""; }

let mountedPage = null;

function route() {
  const r = currentRoute();
  const page = api.auth.canAdmin ? (OPERATOR_PAGES[r] || notFound) : (pages()[r] || forbidden);
  const view = qs("#view");
  if (!view) return;
  mountedPage?.unmount?.();
  const ctx = { navigate: (to) => (location.hash = "#/" + to), rerender: route, params: location.hash.split("/").slice(2) };
  view.innerHTML = `<div class="view">${page.render(ctx)}</div>`;
  page.mount && page.mount(qs(".view", view), ctx);
  mountedPage = page;
  // Moving between sections changes which column is on screen, so the sidebar
  // is rebuilt; moving within one only changes which row is lit.
  const wanted = sectionForRoute(r);
  if (wanted && qs(".rail-item.active")?.dataset.section !== wanted.id) {
    qs("#sidebar")?.replaceWith(el(sidebarHTML()));
    const tabs = tabbarHTML();
    if (tabs) qs("#tabbar")?.replaceWith(el(tabs));
    wireShell();
  } else {
    qsa(".nav-item").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#/" + r));
  }
  const item = navItems().find((entry) => entry.route === r);
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
  applyDensity();
  // Inside Telegram, sign in with what the container already proved before the
  // app has a chance to decide it needs a login form. Outside it this returns
  // null and nothing changes.
  if (inTelegram()) {
    const signedIn = await telegramAuthenticate();
    if (signedIn?.error) console.warn("[telegram]", signedIn.code || signedIn.error);
  }
  await api.detect();
  if (!api.needsAuth) {
    // setScope swaps in this account's own settings, so both preferences have
    // to be read again — the pre-scope values belonged to whoever was here last.
    store.setScope(api.auth.user?.id || "local");
    applyThemeSilent(store.state.settings.theme || "dark");
    applyDensity();
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
  const accountAction = new URLSearchParams(location.search);
  if (accountAction.has("verify") || accountAction.has("reset")) return renderLogin();
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
  // After the shell, so the container's Back and Main buttons have something
  // to point at. A no-op outside Telegram.
  mountTelegramBridge();
  // Anyone whose nav has Mila Live keeps the floating call widget while they
  // browse other tabs — otherwise leaving the page would strand a live call.
  if (pages().mila) mountMilaDock();
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
  const clearAccountAction = () => {
    const url = new URL(location.href);
    url.searchParams.delete("verify");
    url.searchParams.delete("reset");
    history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };
  let mfaChallenge = "";
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
    <div class="field" id="authMfaField"><label class="label" for="loginMfa">${tr("login.mfaCode")}</label><input class="input mono" id="loginMfa" autocomplete="one-time-code" maxlength="16"/><span class="hint">${tr("login.mfaHint")}</span></div>
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
    const mfa = mode === "mfa";
    const terminal = mode === "sent" || mode === "verify";
    qs("#authNameField").hidden = !register;
    qs("#authEmailField").hidden = !(login || register || forgot);
    qs("#authPasswordField").hidden = !(login || register || reset);
    qs("#authMfaField").hidden = !mfa;
    qs(".login-tabs")?.toggleAttribute("hidden", !(login || register));
    qs("#forgotPassword").hidden = !login || !api.auth.accountRecovery.deliveryReady;
    qs("#authBack").hidden = login || register || mode === "verify";
    qs("#authSubmit").hidden = terminal;
    qs("#creatorHint").hidden = !login;
    qs("#loginLead").textContent = tr(register ? "login.registerLead" : forgot ? "login.forgotLead" : reset ? "login.resetLead" : mfa ? "login.mfaLead" : mode === "verify" ? "login.verifying" : "login.lead");
    qs("#authSubmit span").textContent = tr(register ? "login.create" : forgot ? "login.sendReset" : reset ? "login.resetPassword" : mfa ? "login.verifyMfa" : "login.signIn");
    qs("#passwordLabel").textContent = tr(reset ? "login.newPassword" : "login.password");
    qs("#loginPw").autocomplete = register || reset ? "new-password" : "current-password";
    qs("#loginErr").innerHTML = "";
    if (!terminal) (register ? qs("#loginName") : reset ? qs("#loginPw") : mfa ? qs("#loginMfa") : qs("#loginEmail")).focus();
  };
  form.querySelectorAll("[data-auth-mode]").forEach((button) => button.onclick = () => setMode(button.dataset.authMode));
  qs("#forgotPassword").onclick = () => setMode("forgot");
  qs("#authBack").onclick = () => { mfaChallenge = ""; setMode("login"); };
  setMode("login");
  qs("#loginEmail").focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = qs("#authSubmit"); btn.classList.add("loading");
    const body = { email: qs("#loginEmail").value.trim(), password: qs("#loginPw").value };
    try {
      if (form.dataset.mode === "mfa") {
        await api.auth.verifyMfa(mfaChallenge, qs("#loginMfa").value.trim());
        location.reload();
        return;
      }
      if (form.dataset.mode === "forgot") {
        await api.auth.forgotPassword(body.email);
        setMode("sent");
        qs("#loginLead").textContent = tr("login.emailSentText");
        qs("#loginErr").innerHTML = `<div class="alert success"><div class="a-body"><div class="a-title">${tr("login.emailSent")}</div></div></div>`;
        return;
      }
      if (form.dataset.mode === "reset") {
        await api.auth.resetPassword(resetToken, body.password);
        clearAccountAction();
        setMode("sent");
        qs("#loginLead").textContent = tr("login.passwordReset");
        return;
      }
      if (form.dataset.mode === "register") {
        const result = await api.auth.register({ ...body, name: qs("#loginName").value.trim() });
        if (result.verificationRequired) {
          setMode("sent");
          qs("#loginLead").textContent = result.approvalRequired ? tr("login.verificationAndApproval") : tr("login.verificationSent");
          return;
        }
        if (result.approvalRequired) {
          setMode("sent");
          qs("#loginLead").textContent = tr("login.approvalSent");
          return;
        }
      } else {
        const result = await api.auth.login(body);
        if (result.mfaRequired) {
          mfaChallenge = result.challenge;
          qs("#loginPw").value = "";
          setMode("mfa");
          btn.classList.remove("loading");
          return;
        }
      }
      location.reload();
    } catch (err) {
      const message = err.code === "approval_pending" ? tr("login.approvalPending") : (err.message || tr("login.failed"));
      qs("#loginErr").innerHTML = `<div class="field-error" style="margin-bottom:10px">${esc(message)}</div>${err.code === "email_unverified" ? `<button class="btn btn-outline block" id="resendVerification" type="button">${tr("login.resend")}</button>` : ""}`;
      const resend = qs("#resendVerification");
      if (resend) resend.onclick = async () => { await api.auth.resendVerification(body.email); setMode("sent"); qs("#loginLead").textContent = tr("login.verificationSent"); };
      btn.classList.remove("loading");
      if (!qs("#loginMfa").hidden) qs("#loginMfa").focus();
      else if (!qs("#loginPw").hidden) qs("#loginPw").focus();
    }
  };
  if (resetToken) setMode("reset");
  if (verifyToken) {
    setMode("verify");
    api.auth.verifyEmail(verifyToken).then(() => {
      qs("#loginLead").textContent = tr("login.emailVerified");
      qs("#authBack").hidden = false;
    }).catch((error) => {
      qs("#loginErr").innerHTML = `<div class="field-error">${esc(error.message)}</div>`;
      qs("#authBack").hidden = false;
    }).finally(clearAccountAction);
  }
}
function applyThemeSilent(t) { document.documentElement.setAttribute("data-theme", t); }

boot();
