// Command Center — the OS as a living orrery, after RUBRIC Agentic OS
// (RoboNuggets). Two screens share this module: the dashboard (#/command),
// where modules orbit a memory nebula between the day's vitals, and the
// Second Brain map (#/command/map), where the whole system renders as
// concentric particle bands. Deliberately a stage rather than a page: it
// keeps its own black-and-ember palette in both themes, the way a cockpit
// stays dark at noon.
import { api } from "../api.js";
import { icon } from "../icons.js";
import { getLocale, localizedDate, t } from "../i18n.js";
import { databaseHealth } from "../ops-health.js";
import { timeAgo } from "../store.js";
import { erpDigest } from "./erp.js";
import { confirmDialog, esc, toast } from "../ui.js";

const FLEET = [
  { name: "default", label: "Hermes", role: "Orchestrator", icon: "brain", color: "violet" },
  { name: "scout", label: "Scout", role: "Research", icon: "search", color: "teal" },
  { name: "scribe", label: "Scribe", role: "Writing", icon: "edit", color: "blue" },
  { name: "reach", label: "Reach", role: "Growth", icon: "up", color: "amber" },
  { name: "dev", label: "Dev", role: "Engineering", icon: "code", color: "green" },
];
const FLEET_COLORS = { violet: "#a78bfa", teal: "#2dd4bf", blue: "#60a5fa", amber: "#fbbf24", green: "#4ade80" };

// The satellite ring. Labels come from the same nav.* keys the sidebar uses,
// so the orbit never drifts out of translation.
const ORBIT = [
  ["kanban", "workflow"], ["missions", "rocket"], ["routines", "clock"], ["my-tasks", "list"],
  ["agents", "agents"], ["hermes", "brain"], ["claude", "terminal"], ["tools", "tools"],
  ["mcp", "mcp"], ["evaluations", "evaluations"], ["guardrails", "guardrails"], ["observability", "observability"],
  ["erp", "activity"], ["analytics", "monitor"], ["design", "image"], ["media", "video"],
  ["speech", "mic"], ["knowledge", "knowledge"], ["memory", "memory"], ["integrations", "integrations"],
  ["secrets", "secrets"], ["chat", "chat"], ["personal", "user"], ["mila", "sparkles"],
];
const ORBIT_LABEL_KEYS = { "my-tasks": "myTasks", "my-notes": "myNotes" };
const orbitLabel = (route) => t(`nav.${ORBIT_LABEL_KEYS[route] || route}`);

const MICRO_APPS = [
  { route: "command/map", icon: "network", nameKey: "cmd.map.title", descKey: "cmd.app.map" },
  { route: "kanban", icon: "workflow", descKey: "cmd.app.kanban" },
  { route: "missions", icon: "rocket", descKey: "cmd.app.missions" },
  { route: "erp", icon: "activity", descKey: "cmd.app.erp" },
  { route: "knowledge", icon: "knowledge", descKey: "cmd.app.knowledge" },
  { route: "chat", icon: "chat", descKey: "cmd.app.chat" },
];

// Where the business actually is: the factory's own hour, then the markets.
const WORLD_CLOCKS = [["MOSCOW", "Europe/Moscow"], ["DUBAI", "Asia/Dubai"], ["NEW YORK", "America/New_York"]];

const OPEN_STATUSES = new Set(["triage", "todo", "scheduled", "ready", "running", "blocked", "review"]);
const SPIN_SECONDS = 300;

let cmdState = null;
let cmdLoading = false;
let cmdPoll = null;
let clockTimer = null;
let sceneStop = null;
let stageWatch = null;

const rerender = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
const value = (result, fallback) => result.status === "fulfilled" ? result.value : fallback;
const timeoutValue = (fallback, ms) => new Promise((resolve) => setTimeout(() => resolve(fallback), ms));
const bounded = (promise, fallback, ms = 5000) => Promise.race([promise.catch(() => fallback), timeoutValue(fallback, ms)]);
const tasksFrom = (board = {}) => (board.columns || []).flatMap((column) =>
  (column.tasks || []).map((task) => ({ ...task, status: task.status || column.name })));

const parseStamp = (raw) => {
  const stamp = typeof raw === "number" && raw < 1e12 ? raw * 1000 : Date.parse(raw) || Number(raw);
  return Number.isFinite(stamp) && stamp > 0 ? stamp : null;
};
const nextRunAt = (job) => parseStamp(job.next_run_at || job.nextRunAt) ?? Infinity;
const firedToday = (job) => {
  const last = parseStamp(job.last_run_at || job.lastRunAt);
  return last !== null && new Date(last).toDateString() === new Date().toDateString();
};

function routineState(job, soonest) {
  if (job.paused || job.enabled === false || job.status === "paused") return "paused";
  if (job.last_status === "failed" || job.last_error) return "error";
  if (job === soonest) return "next";
  if (firedToday(job)) return "fired";
  return "queued";
}

function fleetWord(profileName, tasks) {
  const mine = tasks.filter((task) => task.assignee === profileName);
  if (mine.some((task) => task.status === "running")) return { key: "dash.state.working", tone: "run" };
  if (mine.some((task) => task.status === "blocked" && task.block_kind === "needs_input")) return { key: "dash.state.waiting", tone: "warn" };
  if (mine.some((task) => task.status === "blocked")) return { key: "dash.state.blocked", tone: "err" };
  if (mine.some((task) => OPEN_STATUSES.has(task.status))) return { key: "dash.state.queued", tone: "dim" };
  return { key: "dash.state.ready", tone: "ok" };
}

// ---------- time ----------

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - jan1) / 86400000 + 1) / 7);
}

function clockParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat(getLocale(), {
    hour: "2-digit", minute: "2-digit", second: "2-digit", ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return { hm: `${get("hour")}:${get("minute")}`, s: get("second"), ap: (get("dayPeriod") || "").toLowerCase() };
}

const zoneHour = (date, timeZone) =>
  Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(date));
const zoneWeekday = (date, timeZone) =>
  new Intl.DateTimeFormat(getLocale(), { weekday: "short", ...(timeZone ? { timeZone } : {}) }).format(date).toUpperCase();
const shortTime = (stamp) =>
  new Intl.DateTimeFormat(getLocale(), { hour: "2-digit", minute: "2-digit" }).format(stamp);

function localZoneLabel(date) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const city = (zone.split("/").pop() || "").replace(/_/g, " ").toUpperCase();
  const abbr = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value || "";
  return [abbr, city].filter(Boolean).join(" · ");
}

// ---------- panels ----------

function panelHead(ico, titleText, extra = "") {
  return `<header class="cmd-panel-head">
    <span class="cmd-panel-ico">${icon(ico)}</span>
    <h2>${esc(titleText)}</h2>
    ${extra}
  </header>`;
}

function appsPanel() {
  return `<section class="cmd-panel" style="--d:1">
    ${panelHead("grid", t("cmd.panel.modules"))}
    <div class="cmd-modlist">${MICRO_APPS.map((app) => `
      <a class="cmd-mod" href="#/${app.route}">
        <span class="cmd-mod-ico">${icon(app.icon)}</span>
        <span class="cmd-mod-body">
          <strong>${esc(app.nameKey ? t(app.nameKey) : orbitLabel(app.route))}</strong>
          <small>${esc(t(app.descKey))}</small>
        </span>
        <span class="cmd-mod-arrow">→</span>
      </a>`).join("")}</div>
  </section>`;
}

function quarterGridHTML(week) {
  let rows = "";
  for (let q = 0; q < 4; q++) {
    const cells = Array.from({ length: 13 }, (_, i) => {
      const n = q * 13 + i + 1;
      return `<i class="${n < week ? "past" : n === week ? "now" : ""}"></i>`;
    }).join("");
    rows += `<div class="cmd-qtr"><b>Q${q + 1}</b>${cells}</div>`;
  }
  return rows;
}

function analogClockSVG(now) {
  const h = (now.getHours() % 12) * 30 + now.getMinutes() * 0.5;
  const m = now.getMinutes() * 6 + now.getSeconds() * 0.1;
  const s = now.getSeconds() * 6;
  return `<svg class="cmd-analog" viewBox="0 0 44 44" aria-hidden="true">
    <circle cx="22" cy="22" r="20"/>
    <line id="cmdAnH" x1="22" y1="22" x2="22" y2="13" transform="rotate(${h} 22 22)"/>
    <line id="cmdAnM" x1="22" y1="22" x2="22" y2="8" transform="rotate(${m} 22 22)"/>
    <line id="cmdAnS" class="s" x1="22" y1="24" x2="22" y2="7" transform="rotate(${s} 22 22)"/>
  </svg>`;
}

function calendarPanel(data, now) {
  const clock = clockParts(now);
  const week = isoWeek(now);
  const dateLine = `${localizedDate(now, { month: "short", day: "numeric", year: "numeric" })} (${localizedDate(now, { weekday: "short" })})`;
  const jobs = (data?.routines || []).filter((job) => !job.paused && job.enabled !== false && nextRunAt(job) !== Infinity)
    .sort((a, b) => nextRunAt(a) - nextRunAt(b)).slice(0, 3);
  return `<section class="cmd-panel" style="--d:2">
    ${panelHead("calendar", t("cmd.panel.calendar"),
      `<button class="cmd-pill" data-sheet="today">${t("dash.open")}</button>`)}
    <div class="cmd-clockrow">
      ${analogClockSVG(now)}
      <div class="cmd-clockcol">
        <div class="cmd-weekline"><b>Wk${week}</b> <span>|</span> ${esc(dateLine)}</div>
        <div class="cmd-clock" role="text"><span id="cmdClockHm">${esc(clock.hm)}</span><span id="cmdClockS">:${esc(clock.s)}</span><span id="cmdClockAp">${clock.ap ? ` ${esc(clock.ap)}` : ""}</span></div>
        <div class="cmd-tz">${esc(localZoneLabel(now))}</div>
      </div>
    </div>
    <div class="cmd-world">${WORLD_CLOCKS.map(([city, zone]) => {
      const hour = zoneHour(now, zone);
      const wc = clockParts(now, zone);
      return `<div class="cmd-world-cell">
        <span class="cmd-world-city">${esc(city)} ${hour >= 7 && hour < 19 ? "☀" : "☾"}</span>
        <span class="cmd-world-time" data-zone="${esc(zone)}"><b>${esc(wc.hm)}${wc.ap ? ` ${esc(wc.ap)}` : ""}</b> <em>(${esc(zoneWeekday(now, zone))})</em></span>
      </div>`;
    }).join("")}</div>
    <div class="cmd-qtrs">${quarterGridHTML(week)}</div>
    ${jobs.length ? `<div class="cmd-next">
      <span class="cmd-subhead">${t("cmd.whatsNext")}</span>
      ${jobs.map((job) => `<a class="cmd-next-row" href="#/routines">
        <span class="cmd-subtext">${esc(job.name || t("routines.unnamed"))}</span>
        <span>${esc(shortTime(nextRunAt(job)))}</span>
      </a>`).join("")}</div>` : ""}
  </section>`;
}

// 28 day-cells of recent activity: pulse history samples and finished missions
// bucketed by calendar day, today ringed.
function activityMatrix(data, now, days = 28) {
  const seen = new Map();
  const dayKey = (stamp) => { const d = new Date(stamp); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  for (const sample of data?.pulse.history || []) {
    const stamp = Number(sample?.t);
    if (Number.isFinite(stamp)) seen.set(dayKey(stamp), true);
  }
  const missionDays = data?.pulse.missions?.days || [];
  for (let i = 0; i < missionDays.length; i++) {
    if ((missionDays[i]?.done || 0) > 0) seen.set(dayKey(Date.now() - (missionDays.length - 1 - i) * 86400000), true);
  }
  let cells = "";
  for (let i = days - 1; i >= 0; i--) {
    const stamp = now.getTime() - i * 86400000;
    const active = seen.has(dayKey(stamp));
    cells += `<i class="${active ? "on" : ""}${i === 0 ? " now" : ""}"></i>`;
  }
  return `<div class="cmd-matrix">${cells}</div>`;
}

function vaultPanel(data, now) {
  const notes = data?.knowledge?.notes;
  const missions = data?.pulse.missions?.doneThisWeek ?? 0;
  return `<section class="cmd-panel" style="--d:3">
    ${panelHead("memory", t("cmd.panel.vault"))}
    <div class="cmd-bigrow">
      <span class="cmd-big">${notes || notes === 0 ? esc(String(notes)) : "—"}</span>
      <span class="cmd-big-side"><b>${t("cmd.vaultNotes")}</b><em>${esc(t("cmd.missionsWeek", { count: missions }))}</em></span>
    </div>
    ${activityMatrix(data, now, 14)}
  </section>`;
}

// The factory beside the memory — what RUBRIC keeps in its "YouTube Studio"
// slot, Milana keeps in production numbers.

// Configured but every tool errored is downtime, not a factory at zero.
const erpSilent = (snapshot, digest) => Object.keys(snapshot?.errors || {}).length > 0
  && !digest.productionOutput && !digest.readyPieces && !digest.activeOrders && !digest.revenue;

function erpPanel(data) {
  const snapshot = data?.erp;
  const digest = snapshot?.configured ? erpDigest(snapshot) : null;
  const num = new Intl.NumberFormat(getLocale());
  return `<section class="cmd-panel" style="--d:4">
    ${panelHead("activity", t("cmd.panel.erp"), `<button class="cmd-pill" data-sheet="erp">${t("dash.open")}</button>`)}
    ${!snapshot ? `<div class="cmd-empty">${t("dash.svc.unreachable")}</div>`
    : !snapshot.configured ? `<div class="cmd-empty">${t("erp.tokenMissing")}</div>`
    : erpSilent(snapshot, digest) ? `<div class="cmd-empty">${t("dash.svc.unreachable")}</div>`
    : `<div class="cmd-big">${esc(num.format(digest.productionOutput || digest.readyPieces))}</div>
      <div class="cmd-big-label">${t(digest.productionOutput ? "erp.productionOutput" : "erp.finishedGoodsPieces")}</div>
      <div class="cmd-erp-rows">
        <span>${t("erp.finishedGoodsPieces")} <b>${esc(num.format(digest.readyPieces))}</b></span>
        <span>${t("erp.lateOrders")} <b class="${digest.lateOrders ? "risk" : ""}">${esc(num.format(digest.lateOrders))}</b></span>
      </div>`}
  </section>`;
}

// RUBRIC's mix bar is tonal, not semantic: ember for the loudest kind, then
// cream, then greys.
const MIX_TONES = ["a", "b", "c", "d"];

function inboxPanel(data) {
  const queue = data?.needs;
  const total = queue?.total ?? (data ? data.pulse.approvals.length : null);
  const items = queue?.items || [];
  const kinds = new Map();
  for (const item of items) kinds.set(item.kind, (kinds.get(item.kind) || 0) + 1);
  const mix = [...kinds.entries()].sort((a, b) => b[1] - a[1]);
  const email = api.auth.user?.email || "";
  const syncedShort = data?.checkedAt ? timeAgo(data.checkedAt) : "";
  return `<section class="cmd-panel" style="--d:4">
    ${panelHead("inbox", t("cmd.panel.inbox"),
      `${syncedShort ? `<span class="cmd-head-note">${esc(syncedShort)}</span>` : ""}<button class="cmd-pill" data-sheet="inbox">${t("dash.open")}</button>`)}
    <div class="cmd-bigrow">
      <span class="cmd-big">${total === null ? "—" : esc(String(total))}</span>
      <span class="cmd-big-side"><b>${t("needs.title")}</b><em>${t("cmd.past24h")}</em></span>
      <span class="cmd-hexmark">⬡</span>
    </div>
    ${items.length ? `<div class="cmd-sublist">
      <span class="cmd-subhead">${t("cmd.flagged")}</span>
      ${items.slice(0, 3).map((item) => `
      <a class="cmd-subrow" href="#/${esc(item.route || "")}">
        <span class="cmd-subico">${icon("mail")}</span>
        <span class="cmd-subtext">${esc(item.title)}</span>
        <span class="cmd-subwhen">${item.since ? esc(timeAgo(new Date(item.since).getTime())) : ""}</span>
      </a>`).join("")}</div>`
    : `<div class="cmd-empty">${t("cmd.allClear")}</div>`}
    ${mix.length ? `<div class="cmd-mix">
      <span class="cmd-subhead">${t("cmd.todaysMix")}</span>
      <div class="cmd-mixbar">${mix.map(([, count], i) =>
        `<i class="${MIX_TONES[i] || "d"}" style="flex:${count}"></i>`).join("")}</div>
      <div class="cmd-mixlegend">${mix.map(([kind, count]) =>
        `<span><b>${count}</b> ${esc(t(`needs.kind.${kind}`))}</span>`).join("")}</div>
    </div>` : ""}
    ${data?.checkedAt ? `<div class="cmd-panel-foot">● ${esc(t("cmd.synced", { time: shortTime(data.checkedAt) }))}${email ? ` · ${esc(email)}` : ""}</div>` : ""}
  </section>`;
}

// Running a skill is a real act: a ready task on the board that the fleet
// will pick up, with the skill named as the work. Confirmed first — the ▶
// spends agent time, and a mis-tap must cost nothing.
function runSkill(name) {
  confirmDialog({
    title: `/${name}`,
    message: t("cmd.runSkillConfirm", { name }),
    confirmText: t("cmd.runSkill"),
    danger: false,
    onConfirm: async () => {
      try {
        await api.kanban.createTask({
          title: `/${name}`,
          body: t("cmd.skillTaskBody", { name }),
          assignee: "default",
          initialStatus: "ready",
          priority: 1,
        });
        toast("success", t("cmd.skillQueued"));
        loadCommand(true);
      } catch (error) {
        toast("error", error.message);
      }
    },
  });
}

const SKILL_ICONS = { operations: "settings", research: "search", writing: "edit", marketing: "up", engineering: "code", content: "image", general: "zap" };

function skillsPanel(data) {
  const tasks = data ? tasksFrom(data.board) : [];
  const skills = data?.skills ?? null;
  const cards = (skills || []).slice()
    .sort((a, b) => ((b.enabled === true) - (a.enabled === true)) || ((Number(b.usage) || 0) - (Number(a.usage) || 0)))
    .slice(0, 4);
  const on = (skills || []).filter((skill) => skill.enabled).length;
  return `<section class="cmd-panel" style="--d:5">
    ${panelHead("zap", t("cmd.panel.skills"),
      `<span class="cmd-head-note">${skills ? esc(t("cmd.enabledCount", { on, total: skills.length })) : t("cmd.tapToRun")}</span><a class="cmd-pill ember" href="#/tools">${t("cmd.addSkill")}</a>`)}
    ${skills === null ? `<div class="cmd-empty">${t("dash.svc.unreachable")}</div>`
    : !cards.length ? `<div class="cmd-empty">${t("cmd.noSkills")}</div>`
    : `<div class="cmd-deck">${cards.map((skill) => `
      <div class="cmd-skill ${skill.enabled ? "" : "off"}">
        <span class="cmd-skill-ico">${icon(SKILL_ICONS[skill.category] || "zap")}</span>
        <span class="cmd-skill-name">/${esc(skill.name)}</span>
        <span class="cmd-skill-meta"><b>${esc(String(skill.category || "general").toUpperCase())}</b> · ${esc(t("cmd.uses", { count: Number(skill.usage) || 0 }))}</span>
        <span class="cmd-skill-actions">
          <button class="cmd-skill-run" data-run-skill="${esc(skill.name)}" aria-label="${t("cmd.runSkill")}" ${skill.enabled && api.auth.canWrite ? "" : "disabled"}>${icon("play")}</button>
          <button class="cmd-skill-cfg" data-open-skill="${esc(skill.name)}" aria-label="${esc(skill.name)}">${icon("settings")}</button>
        </span>
      </div>`).join("")}</div>`}
    <div class="cmd-fleetrow">${FLEET.map((agent) => {
      const word = data ? fleetWord(agent.name, tasks) : { key: "dash.state.ready", tone: "dim" };
      return `<a class="cmd-fleet-chip" href="#/kanban/new/${agent.name}" title="${agent.label} · ${t(word.key)}">
        <span class="cmd-fleet-ico" style="color:${FLEET_COLORS[agent.color]}">${icon(agent.icon)}</span>
        <span>${agent.label}</span><i class="${word.tone}"></i>
      </a>`;
    }).join("")}</div>
  </section>`;
}

function routinesPanel(data) {
  const jobs = (data?.routines || []).slice().sort((a, b) => nextRunAt(a) - nextRunAt(b));
  const soonest = jobs.find((job) => !job.paused && job.enabled !== false && nextRunAt(job) !== Infinity);
  const fired = jobs.filter(firedToday).length;
  const rows = jobs.slice(0, 7);
  return `<section class="cmd-panel" style="--d:6">
    ${panelHead("clock", t("cmd.panel.routines"),
      `<span class="cmd-head-note"><i class="cmd-hexmark sm">⬡</i> ${esc(t("cmd.firedToday", { done: fired, total: jobs.length }))}</span><button class="cmd-pill" data-sheet="routines">${t("dash.open")}</button>`)}
    ${rows.length ? `<div class="cmd-rtable">
      <div class="cmd-rhead"><span>${t("cmd.col.time")}</span><span>${t("cmd.col.routine")}</span><span>${t("cmd.col.status")}</span></div>
      ${rows.map((job) => {
        const state = routineState(job, soonest);
        const at = nextRunAt(job);
        const when = at === Infinity ? "—" : shortTime(at);
        const profile = String(job.profile_name || job.profile || "hermes").toUpperCase();
        return `<a class="cmd-rrow ${state}" href="#/routines">
          <span class="cmd-rtime">${esc(when)}</span>
          <span class="cmd-rname">${esc(job.name || t("routines.unnamed"))} <em>✳ ${esc(profile)}</em></span>
          <span class="cmd-rstatus">${t(`cmd.status.${state}`)}</span>
        </a>`;
      }).join("")}
      <div class="cmd-panel-foot">${esc(t("cmd.dataAt", { time: shortTime(data?.checkedAt || Date.now()) }))}</div>
    </div>` : `<div class="cmd-empty">${t("routines.emptyTitle")}</div>`}
  </section>`;
}

// ---------- dashboard stage ----------

function ledsHTML(data) {
  const leds = [
    ["Hermes", data ? !!data.hermes.ready : null],
    ["MILA", data ? !!data.mila.ok : null],
    ["Claude", data ? !!data.claude.ready : null],
    ["Vault", data ? !!data.knowledge.ready : null],
  ];
  return leds.map(([name, ok]) => `<span class="cmd-led ${ok === null ? "dim" : ok ? "ok" : "down"}"><i></i>${name}</span>`).join("");
}

function orbitHTML() {
  const phase = `animation-delay:-${((Date.now() / 1000) % SPIN_SECONDS).toFixed(1)}s`;
  const step = 360 / ORBIT.length;
  return `<div class="cmd-orbit" id="cmdOrbit">
    <canvas class="cmd-nebula" id="cmdScene"></canvas>
    <div class="cmd-galaxy-tip" id="cmdGalaxyTip" hidden></div>
    <span class="cmd-band" aria-hidden="true"></span>
    <div class="cmd-sats" id="cmdSats" style="${phase}">
      ${ORBIT.map(([route, ico], i) => `
        <a class="cmd-sat" data-route="${route}" style="--a:${(i * step).toFixed(1)}deg" href="#/${route}" aria-label="${esc(orbitLabel(route))}">
          <span class="cmd-sat-chip" style="${phase}">${icon(ico)}<em>${esc(orbitLabel(route))}</em></span>
        </a>`).join("")}
    </div>
    <div class="cmd-filter" id="cmdFilter" hidden>
      <input id="cmdFilterInput" autocomplete="off" spellcheck="false" placeholder="${t("cmd.filterPh")}" aria-label="${t("cmd.filterPh")}"/>
      <span class="cmd-filter-count" id="cmdFilterCount">${t("cmd.brainHint")}</span>
      <div class="cmd-results" id="cmdResults" hidden></div>
    </div>
  </div>`;
}

function tickerHTML(data) {
  const events = (data?.pulse.events || []).slice(0, 3);
  if (!events.length) return "";
  return `<footer class="cmd-ticker">${events.map((event) =>
    `<span>${esc(event.actor || "OS")} · ${esc(event.message || event.type || "")}</span>`).join("<i>▪</i>")}</footer>`;
}

function stageHTML(data) {
  const workspace = data?.onboarding?.workspace?.name || "Agentic OS";
  const now = new Date();
  return `<div class="cmd-stage">
    <div class="cmd-bg" aria-hidden="true"></div>
    ${orbitHTML()}
    <header class="cmd-brand">
      <div class="cmd-title"><span class="cmd-hex">⬡</span> <strong>${esc(workspace)}</strong> <em>Agentic OS</em></div>
      <p class="cmd-sub">${t("cmd.sub")}</p>
      <div class="cmd-quick">
        <a class="cmd-quick-btn" href="#/kanban/new" aria-label="${t("shell.newTask")}">${icon("edit")}</a>
        <button class="cmd-quick-btn" id="cmdSearch" aria-label="${t("cmd.filterPh")}">${icon("search")}</button>
        <a class="cmd-quick-btn" href="#/command/map" aria-label="${t("cmd.map.title")}">${icon("network")}</a>
        <a class="cmd-quick-btn" href="#/observability" aria-label="${t("nav.observability")}">${icon("info")}</a>
      </div>
      <button class="cmd-leds" data-sheet="systems" aria-label="${t("cmd.systems")}">${ledsHTML(data)}</button>
    </header>
    <div class="cmd-col cmd-col-l">
      ${appsPanel()}
      ${calendarPanel(data, now)}
      <div class="cmd-duo">
        ${vaultPanel(data, now)}
        ${erpPanel(data)}
      </div>
    </div>
    <div class="cmd-col cmd-col-r">
      ${inboxPanel(data)}
      ${skillsPanel(data)}
      ${routinesPanel(data)}
    </div>
    ${tickerHTML(data)}
    <a class="cmd-orb" href="#/mila" aria-label="${t("nav.mila")}"></a>
  </div>`;
}

// ---------- second brain: real domains from the real vault ----------

const DOMAIN_COLORS = ["#b78bfa", "#e879f9", "#60a5fa", "#2dd4bf", "#eab308", "#f472b6", "#9adf8f"];
const DOMAIN_LIMIT = 6;

// Group the vault's notes into domains by folder. One wrinkle from the real
// vault: nearly everything can live under a single container folder, which
// would render as one giant blob — so when the biggest top-level folder holds
// most of the vault, we descend into it and let its subfolders be the domains.
export function domainsFrom(nodes = []) {
  if (!nodes.length) return [];
  const segment = (node, depth) => (node.folder || "").split("/")[depth] || (node.folder || "");
  const group = (list, depth) => {
    const map = new Map();
    for (const node of list) {
      const name = segment(node, depth) || "Vault root";
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(node);
    }
    return map;
  };
  let grouped = group(nodes, 0);
  const [biggestName, biggestNotes] = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (biggestNotes.length > nodes.length * 0.6 && biggestNotes.some((node) => (node.folder || "").includes("/"))) {
    grouped.delete(biggestName);
    for (const [sub, list] of group(biggestNotes, 1)) {
      grouped.set(sub, (grouped.get(sub) || []).concat(list));
    }
  }
  const ranked = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length);
  const top = ranked.slice(0, DOMAIN_LIMIT);
  const rest = ranked.slice(DOMAIN_LIMIT).flatMap(([, list]) => list);
  const domains = top.map(([name, list], i) => ({
    name, count: list.length, color: DOMAIN_COLORS[i % DOMAIN_COLORS.length],
    slug: encodeURIComponent(name), notes: list,
  }));
  if (rest.length) domains.push({
    name: t("cmd.dom.other"), count: rest.length, color: "#8a877f",
    slug: encodeURIComponent("__other"), notes: rest,
  });
  return domains;
}

const domainOf = (domains, node) => domains.find((domain) => domain.notes.includes(node));

// A note's seat inside its sector is deterministic — the map holds still
// between visits, and only genuinely new notes move the picture.
function hashFracs(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rand = mulberry32(h);
  return [rand(), rand(), rand()];
}

const HEX_POINTS = "12,1.5 21.1,6.75 21.1,17.25 12,22.5 2.9,17.25 2.9,6.75";

function hexChip(route, ico, angleDeg) {
  return `<a class="cmd-hexchip" style="--a:${angleDeg}deg" href="#/${route}" aria-label="${esc(orbitLabel(route))}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="${HEX_POINTS}" fill="rgba(6,10,14,.7)" stroke="currentColor" stroke-width="1"/></svg>
    <span>${icon(ico)}</span>
  </a>`;
}

// Sector geometry shared by the DOM labels and the canvas: spans are
// proportional to how much of the vault each domain actually holds.
function sectorLayout(domains) {
  const total = domains.reduce((sum, domain) => sum + domain.count, 0) || 1;
  const gap = 10;
  const usable = 360 - gap * Math.max(1, domains.length);
  let cursor = -90;
  return domains.map((domain) => {
    const span = Math.max(24, usable * (domain.count / total));
    const sector = { ...domain, start: cursor, span };
    cursor += span + gap;
    return sector;
  });
}

function mapHTML(data, focus = "") {
  const workspace = data?.onboarding?.workspace?.name || "Agentic OS";
  const step = 360 / ORBIT.length;
  const domains = domainsFrom(data?.graph?.nodes);
  const sectors = sectorLayout(domains);
  const counts = {
    apps: ORBIT.length,
    routines: (data?.routines || []).length,
    memory: data?.knowledge?.notes ?? "—",
    skills: FLEET.length,
  };
  return `<div class="cmd-stage cmd-map">
    <div class="cmd-bg" aria-hidden="true"></div>
    <div class="cmd-map-field" id="cmdMapField">
      <canvas class="cmd-nebula" id="cmdScene"></canvas>
      <span class="cmd-band-label apps">${t("cmd.map.apps")}</span>
      <span class="cmd-band-label" style="--br:0.70;color:#e8c26a">${t("nav.routines")}</span>
      <span class="cmd-band-label" style="--br:0.60;color:#b78bfa">${t("nav.memory")}</span>
      <span class="cmd-band-label skills">${t("cmd.map.skills")}</span>
      <div class="cmd-hexring">${ORBIT.map(([route, ico], i) => hexChip(route, ico, (i * step - 90).toFixed(1))).join("")}</div>
      ${sectors.map((sector) => `
      <a class="cmd-map-node ${focus === sector.slug ? "focus" : ""}" style="--a:${(sector.start + sector.span / 2).toFixed(1)}deg;--nr:0.44"
         href="#/command/map/${focus === sector.slug ? "" : sector.slug}" title="${esc(t("cmd.notesCount", { count: sector.count }))}">
        <i style="background:${sector.color}"></i><span>${esc(sector.name)}</span><b>${sector.count}</b>
      </a>`).join("")}
      <a class="cmd-map-core" href="#/hermes"><strong>HERMES</strong><span>${t("cmd.map.core")}</span></a>
      <div class="cmd-galaxy-tip" id="cmdMapTip" hidden></div>
    </div>
    <header class="cmd-map-head">
      <div class="cmd-title"><span class="cmd-hex">⬡</span> <strong>${esc(workspace)}</strong> <em class="dim">${t("cmd.map.title")}</em></div>
      <p class="cmd-sub">Hermes | ${esc(workspace)}</p>
    </header>
    <div class="cmd-map-actions">
      <a class="cmd-map-btn" href="#/command">← ${t("cmd.map.back")}</a>
    </div>
    <div class="cmd-map-legendwrap">
      <button class="cmd-map-btn" id="cmdLegendBtn">◆ ${t("cmd.map.legend")}</button>
      <div class="cmd-map-legend" id="cmdLegend" hidden>
        <div><i style="background:#e8c26a"></i>${t("cmd.map.apps")}<b>${esc(String(counts.apps))}</b></div>
        <div><i style="background:#6aa9ff"></i>${t("nav.routines")}<b>${esc(String(counts.routines))}</b></div>
        <div><i style="background:#b78bfa"></i>${t("nav.memory")}<b>${esc(String(counts.memory))}</b></div>
        <div><i style="background:#ff8a2a"></i>${t("cmd.map.skills")}<b>${esc(String(counts.skills))}</b></div>
      </div>
    </div>
  </div>`;
}

// ---------- canvas scenes ----------

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let s = Math.imul(a ^ (a >>> 15), 1 | a);
    s = (s + Math.imul(s ^ (s >>> 7), 61 | s)) ^ s;
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

// The galaxy: a dense white-hot core with the fleet's hues as minority sparks,
// after the reference — mostly white, then pink/teal/blue/ember dust.
const DUST = ["#f5efe6", "#ffffff", "#ffb25e", "#f472b6", "#2dd4bf", "#60a5fa", "#c084fc", "#ff7a1a"];
const DUST_WEIGHT = [0.3, 0.22, 0.12, 0.09, 0.09, 0.08, 0.05, 0.05];

function makeParticles(count, maxR, rand) {
  const pick = () => {
    let roll = rand(), i = 0;
    while (i < DUST_WEIGHT.length - 1 && (roll -= DUST_WEIGHT[i]) > 0) i++;
    return DUST[i];
  };
  return Array.from({ length: count }, () => {
    const r = 3 + maxR * Math.pow(rand(), 2.1);
    return {
      r, a0: rand() * Math.PI * 2,
      w: (0.05 + 0.5 / (1 + r * 0.03)) * (rand() < 0.85 ? 1 : -1) * 0.2,
      amp: 1 + rand() * 3, f: 0.1 + rand() * 0.3, ph: rand() * Math.PI * 2,
      size: 0.5 + rand() * 1.1, alpha: 0.3 + rand() * 0.6, tw: 0.2 + rand() * 0.8,
      color: pick(),
    };
  });
}

// The geodesic sphere behind the galaxy: points spread by the golden angle,
// linked to their 3D neighbours, rotated as one body and projected flat.
function makeSphere(count, radius) {
  const points = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = golden * i;
    points.push({ x: Math.cos(a) * r * radius, y: y * radius, z: Math.sin(a) * r * radius });
  }
  const links = [];
  const limit = (radius * 3.9 / Math.sqrt(count)) ** 2;
  points.forEach((p, i) => {
    for (let j = i + 1; j < points.length; j++) {
      const q = points[j];
      if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2 < limit) links.push([i, j]);
    }
  });
  return { points, links };
}

function startDashboardScene(canvas, host, { domains = [] } = {}) {
  let particles = [], clusters = [], sphere = null, cx = 0, cy = 0;
  const TILT = 0.42;
  const build = (w, h) => {
    cx = w / 2; cy = h / 2;
    const rand = mulberry32(7);
    const base = Math.min(w, h);
    sphere = makeSphere(46, base * 0.33);
    // Neutral core dust stays; each vault domain adds its own coloured
    // cluster, sized by how many notes actually live there.
    particles = makeParticles(w < 900 ? 150 : (domains.length ? 240 : 420), base * (domains.length ? 0.13 : 0.17), rand);
    clusters = domains.map((domain, i) => {
      const angle = (i / Math.max(1, domains.length)) * Math.PI * 2 + 0.7;
      const dist = base * (0.05 + 0.075 * (0.5 + ((i * 2) % 3) / 2));
      const size = 12 + Math.sqrt(domain.count) * 6.5;
      const x = cx + Math.cos(angle) * dist;
      const y = cy + Math.sin(angle) * dist * 0.9;
      const dots = Array.from({ length: Math.min(90, 10 + domain.count * 3) }, () => ({
        r: size * Math.pow(rand(), 1.6), a0: rand() * Math.PI * 2,
        w: (0.1 + rand() * 0.35) * (rand() < 0.85 ? 1 : -1),
        size: 0.5 + rand() * 1.2, alpha: 0.3 + rand() * 0.6,
        tw: 0.2 + rand() * 0.8, ph: rand() * Math.PI * 2,
        color: rand() < 0.68 ? domain.color : "#f5efe6",
      }));
      return { ...domain, x, y, size, dots };
    });
  };
  const project = (p, cos, sin) => {
    const x = p.x * cos - p.z * sin;
    const z = p.x * sin + p.z * cos;
    return [cx + x, cy + p.y * Math.cos(TILT) - z * Math.sin(TILT)];
  };
  const draw = (ctx, tSec) => {
    if (sphere) {
      const spin = tSec * 0.05;
      const cos = Math.cos(spin), sin = Math.sin(spin);
      ctx.strokeStyle = "rgba(215, 224, 238, 0.05)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [i, j] of sphere.links) {
        const [ax, ay] = project(sphere.points[i], cos, sin);
        const [bx, by] = project(sphere.points[j], cos, sin);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
      ctx.fillStyle = "rgba(215, 224, 238, 0.12)";
      for (const p of sphere.points) {
        const [x, y] = project(p, cos, sin);
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }
    ctx.globalCompositeOperation = "lighter";
    for (const p of particles) {
      const angle = p.a0 + p.w * tSec;
      const radius = p.r + Math.sin(tSec * p.f + p.ph) * p.amp;
      ctx.globalAlpha = p.alpha * (0.7 + 0.3 * Math.sin(tSec * p.tw + p.ph));
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius * 0.92, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const cluster of clusters) {
      for (const p of cluster.dots) {
        const angle = p.a0 + p.w * tSec;
        ctx.globalAlpha = p.alpha * (0.7 + 0.3 * Math.sin(tSec * p.tw + p.ph));
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(cluster.x + Math.cos(angle) * p.r, cluster.y + Math.sin(angle) * p.r * 0.92, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  };
  const stop = runScene(canvas, host, build, draw);
  // The galaxy is the vault: hovering a cluster names the shelf, clicking
  // opens the map focused on it.
  const tip = host.querySelector("#cmdGalaxyTip");
  const clusterAt = (event) => {
    const box = canvas.getBoundingClientRect();
    const mx = event.clientX - box.left, my = event.clientY - box.top;
    return clusters.find((cluster) => (cluster.x - mx) ** 2 + (cluster.y - my) ** 2 < (cluster.size + 14) ** 2) || null;
  };
  const onMove = (event) => {
    const cluster = clusterAt(event);
    canvas.style.cursor = cluster ? "pointer" : "";
    if (!tip) return;
    if (!cluster) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.textContent = `${cluster.name} · ${t("cmd.notesCount", { count: cluster.count })}`;
    tip.style.left = `${cluster.x}px`;
    tip.style.top = `${cluster.y - cluster.size - 12}px`;
  };
  const onClick = (event) => {
    const cluster = clusterAt(event);
    if (cluster) location.hash = `#/command/map/${cluster.slug}`;
  };
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("click", onClick);
  return () => {
    canvas.removeEventListener("mousemove", onMove);
    canvas.removeEventListener("click", onClick);
    stop();
  };
}

// The map, from the vault itself: every dot in the memory band is a real
// note seated in its folder's sector, and every faint line is a real link
// between notes. Orange skill rings circle the core, one gold seat per
// routine, the dotted application rail outside.
function startMapScene(canvas, host, { domains = [], edges = [], routines = 0, focus = "", onNote = null } = {}) {
  let seats = [], skillRings = [], web = null, notes = [], cx = 0, cy = 0, R = 0;
  const build = (w, h) => {
    cx = w / 2; cy = h / 2;
    R = Math.min(w, h) / 2 - 44;
    const rand = mulberry32(11);
    skillRings = Array.from({ length: 5 }, (_, i) => ({
      r: R * (0.10 + i * 0.026), dots: 26 + i * 8, speed: (i % 2 ? -1 : 1) * (0.03 + i * 0.008),
    }));
    web = makeSphere(36, R * 0.7);
    seats = [];
    const seatCount = Math.max(6, Math.min(28, routines || 10));
    for (let i = 0; i < seatCount; i++) seats.push(-Math.PI / 2 + (i / seatCount) * Math.PI * 2);
    // Seat every note in its sector. A huge vault is sampled per sector so
    // the picture stays honest about proportions without drowning the GPU.
    notes = [];
    const sectors = sectorLayout(domains);
    const total = domains.reduce((sum, domain) => sum + domain.count, 0) || 1;
    for (const sector of sectors) {
      const cap = total > 450 ? Math.max(6, Math.ceil(450 * (sector.count / total))) : Infinity;
      const dimmed = focus && focus !== sector.slug;
      let seated = 0;
      for (const node of sector.notes) {
        if (seated++ >= cap) break;
        const [f1, f2, f3] = hashFracs(node.id || node.label || String(seated));
        const angle = (sector.start + f1 * sector.span) * Math.PI / 180;
        const radius = R * (0.30 + f2 * 0.28);
        notes.push({
          id: node.id, label: node.label || node.id, folder: node.folder || sector.name,
          x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius,
          size: 1.4 + f3 * 1.3, color: sector.color, ph: f3 * Math.PI * 2, dimmed,
        });
      }
    }
  };
  const seatOf = new Map();
  const draw = (ctx, tSec) => {
    if (seatOf.size !== notes.length) { seatOf.clear(); for (const note of notes) seatOf.set(note.id, note); }
    if (web) {
      ctx.strokeStyle = "rgba(200, 210, 230, 0.02)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [i, j] of web.links) {
        const p = web.points[i], q = web.points[j];
        ctx.moveTo(cx + p.x, cy + p.y);
        ctx.lineTo(cx + q.x, cy + q.y);
      }
      ctx.stroke();
    }
    // real links between real notes
    if (edges.length && notes.length) {
      ctx.lineWidth = 1;
      ctx.beginPath();
      let drawn = 0;
      for (const edge of edges) {
        const a = seatOf.get(edge.source), b = seatOf.get(edge.target);
        if (!a || !b || drawn++ > 900) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.strokeStyle = "rgba(220, 214, 235, 0.06)";
      ctx.stroke();
    }
    // rails: dotted gold for applications, solid-faint for routines
    ctx.setLineDash([1.5, 7]);
    ctx.strokeStyle = "rgba(232, 194, 106, 0.5)";
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(232, 194, 106, 0.22)";
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.66, 0, Math.PI * 2); ctx.stroke();
    ctx.globalCompositeOperation = "lighter";
    // one gold seat per routine
    ctx.strokeStyle = "rgba(232, 194, 106, 0.75)";
    ctx.fillStyle = "#e8c26a";
    for (let i = 0; i < seats.length; i++) {
      const x = cx + Math.cos(seats[i]) * R * 0.66, y = cy + Math.sin(seats[i]) * R * 0.66;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 0.65 + 0.35 * Math.sin(tSec * 0.9 + i);
      ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill();
    }
    // orange skill rings
    ctx.fillStyle = "#ff8a2a";
    for (const ring of skillRings) {
      const base = tSec * ring.speed;
      for (let i = 0; i < ring.dots; i++) {
        const a = base + (i / ring.dots) * Math.PI * 2;
        ctx.globalAlpha = 0.5 + 0.4 * Math.sin(tSec + i);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * ring.r, cy + Math.sin(a) * ring.r, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // the vault itself
    for (const note of notes) {
      ctx.globalAlpha = (note.dimmed ? 0.16 : 0.55) + (note.dimmed ? 0 : 0.4 * Math.sin(tSec * 0.8 + note.ph));
      ctx.fillStyle = note.color;
      ctx.beginPath();
      ctx.arc(note.x, note.y, note.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  };
  const stop = runScene(canvas, host, build, draw);
  // The dots are clickable notes: nearest within reach opens the note itself.
  const tip = host.querySelector("#cmdMapTip");
  const nearest = (event) => {
    const box = canvas.getBoundingClientRect();
    const mx = event.clientX - box.left, my = event.clientY - box.top;
    let best = null, bestD = 121;
    for (const note of notes) {
      if (note.dimmed) continue;
      const d = (note.x - mx) ** 2 + (note.y - my) ** 2;
      if (d < bestD) { best = note; bestD = d; }
    }
    return best;
  };
  const onMove = (event) => {
    const note = nearest(event);
    canvas.style.cursor = note ? "pointer" : "";
    if (!tip) return;
    if (!note) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.textContent = note.label;
    tip.style.left = `${note.x}px`;
    tip.style.top = `${note.y - 16}px`;
  };
  const onClick = (event) => {
    const note = nearest(event);
    if (note && onNote) onNote(note);
  };
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("click", onClick);
  return () => {
    canvas.removeEventListener("mousemove", onMove);
    canvas.removeEventListener("click", onClick);
    stop();
  };
}

// Shared scene runner: DPR-aware sizing, a 30fps cap, stillness under
// prefers-reduced-motion, and a full stop on unmount.
function runScene(canvas, host, build, draw) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let raf = 0, disposed = false, last = 0, width = 0, height = 0;
  const size = () => {
    const box = host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = box.width; height = box.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build(width, height);
  };
  const frame = (stamp) => {
    if (disposed) return;
    if (!canvas.offsetWidth) { setTimeout(() => { if (!disposed && !document.hidden) raf = requestAnimationFrame(frame); }, 2000); return; }
    if (stamp - last < 33) { raf = requestAnimationFrame(frame); return; }
    last = stamp;
    ctx.clearRect(0, 0, width, height);
    draw(ctx, Date.now() / 1000);
    if (!still) raf = requestAnimationFrame(frame);
  };
  size();
  raf = requestAnimationFrame(frame);
  const onVisible = () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else { last = 0; raf = requestAnimationFrame(frame); }
  };
  document.addEventListener("visibilitychange", onVisible);
  const watcher = new ResizeObserver(() => { size(); if (still) { last = 0; raf = requestAnimationFrame(frame); } });
  watcher.observe(host);
  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    document.removeEventListener("visibilitychange", onVisible);
    watcher.disconnect();
  };
}

// ---------- centre search: filter the ring, or Enter to search the brain ----------

const RESULT_ICONS = {
  note: "knowledge", task: "workflow", chat: "chat", mission: "rocket", routine: "clock",
  skill: "zap", studio: "image", memory: "memory", erp: "activity",
};

function brainResultsHTML(data) {
  if (!data.results.length) return `<div class="cmd-res-note">${t("cmd.brainEmpty")}</div>`;
  const groups = new Map();
  for (const row of data.results) {
    if (!groups.has(row.type)) groups.set(row.type, []);
    groups.get(row.type).push(row);
  }
  const silent = data.sources.filter((source) => !source.ok).map((source) => source.name);
  return [...groups.entries()].map(([type, rows]) => `
    <div class="cmd-res-group">
      <span class="cmd-res-head">${icon(RESULT_ICONS[type] || "dot")} ${t(`cmd.type.${type}`)}</span>
      ${rows.map((row) => `<a class="cmd-res-row" href="#/${esc(row.route)}" data-type="${esc(row.type)}" data-id="${esc(row.id || "")}">
        <b>${esc(row.title)}</b>${row.snippet ? `<small>${esc(row.snippet)}</small>` : ""}
      </a>`).join("")}
    </div>`).join("")
    + (data.partial ? `<div class="cmd-res-note">◇ ${t("cmd.brainPartial")}: ${esc(silent.join(", "))}</div>` : "");
}

function wireBrainSearch(root) {
  const button = root.querySelector("#cmdSearch");
  const box = root.querySelector("#cmdFilter");
  const input = root.querySelector("#cmdFilterInput");
  const count = root.querySelector("#cmdFilterCount");
  const results = root.querySelector("#cmdResults");
  const sats = [...root.querySelectorAll(".cmd-sat")];
  if (!button || !box || !input) return;
  const applyFilter = () => {
    const q = input.value.trim().toLowerCase();
    let hits = 0;
    for (const sat of sats) {
      const label = orbitLabel(sat.dataset.route).toLowerCase();
      const hit = q && (label.includes(q) || sat.dataset.route.includes(q));
      sat.classList.toggle("hit", !!hit);
      sat.classList.toggle("miss", !!q && !hit);
      if (hit) hits++;
    }
    count.textContent = q ? `${t("cmd.matches", { count: hits })} · ${t("cmd.brainHint")}` : t("cmd.brainHint");
  };
  const closeResults = () => { results.hidden = true; results.innerHTML = ""; };
  const close = () => {
    box.hidden = true;
    input.value = "";
    closeResults();
    applyFilter();
  };
  let seq = 0;
  const runSearch = async () => {
    const q = input.value.trim();
    if (q.length < 2) return;
    const mine = ++seq;
    results.hidden = false;
    results.innerHTML = `<div class="cmd-res-note">${t("cmd.searching")}</div>`;
    try {
      const data = await api.brain.search(q);
      if (mine !== seq) return;
      results.innerHTML = brainResultsHTML(data);
    } catch (error) {
      if (mine !== seq) return;
      results.innerHTML = `<div class="cmd-res-note">${esc(error.message)}</div>`;
    }
  };
  button.addEventListener("click", () => {
    box.hidden = !box.hidden;
    if (!box.hidden) { count.textContent = t("cmd.brainHint"); input.focus(); }
    else close();
  });
  // Notes and skills open as sheets right here; everything else navigates.
  results.addEventListener("click", (event) => {
    const row = event.target.closest(".cmd-res-row");
    if (!row || !row.dataset.id) return;
    if (row.dataset.type === "note") { event.preventDefault(); openNoteSheet(root, encodeURIComponent(row.dataset.id)); }
    else if (row.dataset.type === "skill") { event.preventDefault(); openSkillSheet(root, encodeURIComponent(row.dataset.id)); }
  });
  input.addEventListener("input", () => { closeResults(); applyFilter(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.stopPropagation(); results.hidden ? close() : closeResults(); }
    else if (event.key === "Enter") { event.preventDefault(); runSearch(); }
  });
}

// ---------- data ----------

// Walking the vault costs real file reads, so the graph refreshes on its own
// slower clock than the 45-second vitals poll. The ERP snapshot is heavier
// still — every GET runs eight live MCP tools against the factory — so it
// gets the same treatment.
let cmdGraph = null;
const GRAPH_TTL = 5 * 60 * 1000;
let cmdErp = null;
const ERP_TTL = 3 * 60 * 1000;

async function loadCommand(force = false) {
  if (cmdLoading && !force) return;
  cmdLoading = true;
  const graphFresh = cmdGraph && Date.now() - cmdGraph.at < GRAPH_TTL;
  const results = await Promise.allSettled([
    bounded(api.pulse.status(), { host: {}, approvals: [], events: [], history: [], missions: null }, 8000),
    bounded(api.kanban.board(), { columns: [] }),
    bounded(api.routines.list("all"), []),
    bounded(api.needsYou(), null, 4000),
    bounded(api.knowledge.status(), {}),
    bounded(api.hermes.status(), { ready: false }, 3500),
    bounded(api.integrations.milaStatus(), { ok: false }, 3500),
    bounded(api.claude.status(true), { ready: false }, 5000),
    bounded(api.onboarding.get(), { workspace: {} }),
    graphFresh ? Promise.resolve(cmdGraph.data) : bounded(api.knowledge.graph(), null, 6000),
    bounded(api.skills.list().then((r) => Array.isArray(r) ? r : []), null, 5000),
    cmdErp && Date.now() - cmdErp.at < ERP_TTL ? Promise.resolve(cmdErp.data) : bounded(api.erp.snapshot(), null, 9000),
  ]);
  const graph = value(results[9], null);
  if (graph) cmdGraph = { data: graph, at: graphFresh ? cmdGraph.at : Date.now() };
  const erp = value(results[11], null);
  if (erp) cmdErp = { data: erp, at: cmdErp && erp === cmdErp.data ? cmdErp.at : Date.now() };
  cmdState = {
    graph: cmdGraph?.data || { nodes: [], edges: [] },
    skills: value(results[10], null),
    erp: cmdErp?.data || null,
    pulse: value(results[0], { host: {}, approvals: [], events: [], history: [], missions: null }),
    board: value(results[1], { columns: [] }),
    routines: value(results[2], []),
    needs: value(results[3], null),
    knowledge: value(results[4], {}),
    hermes: value(results[5], { ready: false }),
    mila: value(results[6], { ok: false }),
    claude: value(results[7], { ready: false }),
    onboarding: value(results[8], { workspace: {} }),
    checkedAt: Date.now(),
  };
  cmdLoading = false;
  // A full rerender rebuilds the stage — never underneath an open search or
  // an open sheet, or the operator's place vanishes mid-thought. The next
  // poll (or closing the overlay) picks the fresh data up.
  if (!document.querySelector("#cmdFilter:not([hidden]), .cmd-sheet")) rerender();
}

/* ---------- sheets (Ф3) ----------
   The day's operations without leaving the stage: a right-hand overlay in the
   stage's own language, deep-linkable as #/command/sheet/<name>[/arg] via
   replaceState — the URL names the open sheet, but opening one never rebuilds
   the stage underneath it. */

let sheetClose = null;
const SHEET_FOCUS = 'a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])';

function openSheet(root, { name, arg = "", ico = "file", title, subtitle = "", body }) {
  sheetClose?.();
  const stage = root.querySelector(".cmd-stage");
  if (!stage) return null;
  // A dialog borrows focus; closing hands it back to whoever opened it.
  const opener = document.activeElement;
  const base = location.hash.startsWith("#/command/map") ? "#/command/map" : "#/command";
  const scrim = document.createElement("div");
  scrim.className = "cmd-sheet-scrim";
  const panel = document.createElement("aside");
  panel.className = "cmd-sheet";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.innerHTML = `<header class="cmd-sheet-head">
      <span class="cmd-panel-ico">${icon(ico)}</span>
      <div class="cmd-sheet-title"><strong>${esc(title)}</strong>${subtitle ? `<small>${esc(subtitle)}</small>` : ""}</div>
      <button class="cmd-sheet-x" aria-label="${t("shell.close")}">${icon("x")}</button>
    </header>
    <div class="cmd-sheet-body">${body}</div>`;
  // On <body>, not in the stage: a fixed dialog inside an animated subtree
  // inherits the transform as its containing block and stops being fixed.
  document.body.append(scrim, panel);
  const onKey = (event) => {
    if (event.key === "Escape") { event.stopPropagation(); sheetClose?.(); return; }
    if (event.key !== "Tab") return;
    const stops = [...panel.querySelectorAll(SHEET_FOCUS)].filter((node) => node.offsetParent !== null);
    if (!stops.length) return;
    const [first, last] = [stops[0], stops[stops.length - 1]];
    if (!panel.contains(document.activeElement)) { event.preventDefault(); first.focus(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", onKey, true);
  scrim.addEventListener("click", () => sheetClose?.());
  panel.querySelector(".cmd-sheet-x").addEventListener("click", () => sheetClose?.());
  sheetClose = () => {
    panel.remove();
    scrim.remove();
    document.removeEventListener("keydown", onKey, true);
    sheetClose = null;
    if (location.hash.startsWith("#/command/sheet")) history.replaceState(null, "", base);
    if (opener && document.contains(opener) && typeof opener.focus === "function") opener.focus();
  };
  history.replaceState(null, "", `#/command/sheet/${name}${arg ? `/${arg}` : ""}`);
  panel.querySelector(".cmd-sheet-x")?.focus();
  return panel;
}

const sheetBody = (panel) => panel?.querySelector(".cmd-sheet-body");

// --- inbox: the full needs-you queue, decidable in place ---

export const approvalIdOf = (item) => String(item?.id || "").startsWith("apr_") ? String(item.id).slice(4) : String(item?.id || "");

function inboxSheetRowsHTML(queue) {
  const items = queue?.items || [];
  if (!items.length) return `<div class="cmd-empty">${t("needs.empty")}</div>`;
  return items.map((item) => `
    <div class="cmd-sheet-row">
      <span class="cmd-subdot ${esc(item.severity || "attention")}"></span>
      <div class="cmd-sheet-row-body">
        <strong>${esc(item.title)}</strong>
        <small>${esc(t(`needs.kind.${item.kind}`))}${item.detail ? ` · ${esc(item.detail)}` : ""}${item.since ? ` · ${esc(timeAgo(new Date(item.since).getTime()))}` : ""}</small>
      </div>
      ${item.kind === "approval" && api.auth.canAdmin
        ? `<span class="cmd-sheet-acts">
            <button class="cmd-mini-btn ember" data-decide="approve" data-id="${esc(approvalIdOf(item))}">${t("dash.approve")}</button>
            <button class="cmd-mini-btn" data-decide="deny" data-id="${esc(approvalIdOf(item))}">${t("dash.deny")}</button>
          </span>`
        : `<a class="cmd-mini-btn" href="#/${esc(item.route || "")}">${t("dash.open")}</a>`}
    </div>`).join("");
}

async function renderInboxSheet(panel) {
  const body = sheetBody(panel);
  if (!body) return;
  const queue = await bounded(api.needsYou(), null, 4000);
  if (!sheetBody(panel)) return;
  body.innerHTML = inboxSheetRowsHTML(queue);
  body.querySelectorAll("[data-decide]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api.pulse.decideApproval(button.dataset.id, button.dataset.decide);
      toast("success", t(button.dataset.decide === "approve" ? "dash.approved" : "dash.denied"));
      await renderInboxSheet(panel);
      loadCommand(true);
    } catch (error) {
      button.disabled = false;
      toast("error", error.message);
    }
  }));
}

function openInboxSheet(root) {
  const panel = openSheet(root, {
    name: "inbox", ico: "inbox", title: t("cmd.panel.inbox"), subtitle: t("needs.title"),
    body: `<div class="cmd-empty">${t("needs.loading")}</div>`,
  });
  if (panel) renderInboxSheet(panel);
}

// --- routines: pause, resume, run — in place ---

function routinesSheetRowsHTML(jobs) {
  if (!jobs.length) return `<div class="cmd-empty">${t("routines.emptyTitle")}</div>`;
  const soonest = jobs.find((job) => !job.paused && job.enabled !== false && nextRunAt(job) !== Infinity);
  return jobs.map((job) => {
    const state = routineState(job, soonest);
    const id = job.id || job.name;
    const profile = job.profile_name || job.profile || "default";
    const at = nextRunAt(job);
    return `<div class="cmd-sheet-row ${state === "paused" ? "dim" : ""}">
      <span class="cmd-routine-led ${state === "next" ? "live" : state}"></span>
      <div class="cmd-sheet-row-body">
        <strong>${esc(job.name || t("routines.unnamed"))}</strong>
        <small class="mono">${esc(job.schedule || "")}${at !== Infinity ? ` · ${esc(shortTime(at))}` : ""} · ${esc(String(profile).toUpperCase())}</small>
      </div>
      ${api.auth.canAdmin ? `<span class="cmd-sheet-acts">
        <button class="cmd-mini-btn ember" data-raction="trigger" data-id="${esc(id)}" data-profile="${esc(profile)}" title="${t("routines.runNow")}">${icon("play")}</button>
        <button class="cmd-mini-btn" data-raction="${state === "paused" ? "resume" : "pause"}" data-id="${esc(id)}" data-profile="${esc(profile)}" title="${t(state === "paused" ? "routines.resume" : "routines.pause")}">${icon(state === "paused" ? "play" : "pause")}</button>
      </span>` : ""}
    </div>`;
  }).join("");
}

async function renderRoutinesSheet(panel) {
  const body = sheetBody(panel);
  if (!body) return;
  const jobs = await bounded(api.routines.list("all").then((r) => Array.isArray(r) ? r : r?.jobs || []), null, 5000);
  if (!sheetBody(panel)) return;
  if (!jobs) { body.innerHTML = `<div class="cmd-empty">${t("dash.svc.unreachable")}</div>`; return; }
  body.innerHTML = routinesSheetRowsHTML(jobs.slice().sort((a, b) => nextRunAt(a) - nextRunAt(b)));
  body.querySelectorAll("[data-raction]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api.routines.action(button.dataset.id, button.dataset.raction, button.dataset.profile);
      toast("success", t("dash.refreshed"));
      await renderRoutinesSheet(panel);
      loadCommand(true);
    } catch (error) {
      button.disabled = false;
      toast("error", error.message);
    }
  }));
}

function openRoutinesSheet(root) {
  const panel = openSheet(root, {
    name: "routines", ico: "clock", title: t("cmd.panel.routines"),
    body: `<div class="cmd-empty">${t("needs.loading")}</div>`,
  });
  if (panel) renderRoutinesSheet(panel);
}

// --- today: my tasks and my hours, done-able in place ---

async function renderTodaySheet(panel) {
  const body = sheetBody(panel);
  if (!body) return;
  const [tasks, events] = await Promise.all([
    bounded(api.member.tasks().then((r) => Array.isArray(r) ? r : r?.tasks || []), null, 4000),
    bounded(api.personal.googleEvents({ limit: 5 }).then((r) => Array.isArray(r) ? r : r?.events || []), [], 4000),
  ]);
  if (!sheetBody(panel)) return;
  const open = (tasks || []).filter((task) => task.status !== "done");
  body.innerHTML = `
    ${events.length ? `<span class="cmd-subhead">${t("cmd.panel.calendar")}</span>
      ${events.map((event) => `<div class="cmd-sheet-row"><span class="cmd-subdot"></span>
        <div class="cmd-sheet-row-body"><strong>${esc(event.summary || event.title || "")}</strong>
        <small>${event.start ? esc(shortTime(Date.parse(event.start?.dateTime || event.start?.date || event.start))) : ""}</small></div></div>`).join("")}` : ""}
    <span class="cmd-subhead">${t("nav.myTasks")}</span>
    ${tasks === null ? `<div class="cmd-empty">${t("dash.svc.unreachable")}</div>`
      : open.length ? open.map((task) => `
        <div class="cmd-sheet-row">
          <button class="cmd-check" data-done="${esc(task.id)}" aria-label="${t("telegram.act.done")}"></button>
          <div class="cmd-sheet-row-body"><strong>${esc(task.title)}</strong>
            ${task.status === "doing" ? `<small>${t("member.status.doing")}</small>` : ""}</div>
        </div>`).join("")
      : `<div class="cmd-empty">${t("cmd.todayEmpty")}</div>`}`;
  body.querySelectorAll("[data-done]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api.member.updateTask(button.dataset.done, { status: "done" });
      toast("success", t("telegram.act.done"));
      renderTodaySheet(panel);
    } catch (error) {
      button.disabled = false;
      toast("error", error.message);
    }
  }));
}

function openTodaySheet(root) {
  const panel = openSheet(root, {
    name: "today", ico: "home", title: t("nav.sec.today"),
    subtitle: localizedDate(new Date(), { weekday: "long", day: "numeric", month: "long" }),
    body: `<div class="cmd-empty">${t("needs.loading")}</div>`,
  });
  if (panel) renderTodaySheet(panel);
}

// --- note: read and append, without leaving the stage ---

function openNoteSheet(root, argPath, meta = null) {
  const path = decodeURIComponent(argPath);
  const label = meta?.label || path.split("/").pop().replace(/\.md$/i, "");
  const panel = openSheet(root, {
    name: "note", arg: encodeURIComponent(path), ico: "knowledge",
    title: label, subtitle: meta?.folder || path,
    body: `<div class="cmd-sheet-prose">${t("cmd.noteLoading")}</div>
      <form class="cmd-sheet-append">
        <textarea rows="2" placeholder="${t("cmd.noteAppendPh")}" aria-label="${t("cmd.noteAppendPh")}"></textarea>
        <div class="cmd-sheet-acts">
          <button class="cmd-mini-btn ember" type="submit">${t("cmd.noteAppend")}</button>
          <a class="cmd-mini-btn" href="#/knowledge">${t("cmd.noteOpen")}</a>
        </div>
      </form>`,
  });
  if (!panel) return;
  const prose = panel.querySelector(".cmd-sheet-prose");
  api.knowledge.read(path)
    .then((data) => { if (prose) prose.textContent = data.content ?? data.text ?? ""; })
    .catch((error) => { if (prose) prose.textContent = error.message; });
  panel.querySelector(".cmd-sheet-append").addEventListener("submit", async (event) => {
    event.preventDefault();
    const area = panel.querySelector("textarea");
    const text = area.value.trim();
    if (!text) return;
    try {
      await api.knowledge.append({ path, text });
      if (prose) prose.textContent = `${prose.textContent}\n${text}`;
      area.value = "";
      toast("success", t("cmd.noteSaved"));
      cmdGraph = null;
    } catch (error) {
      toast("error", error.message);
    }
  });
}

// --- skill: read the instructions, switch it on or off ---

function openSkillSheet(root, argName) {
  const name = decodeURIComponent(argName);
  const panel = openSheet(root, {
    name: "skill", arg: encodeURIComponent(name), ico: "zap",
    title: `/${name.replace(/^\//, "")}`, subtitle: t("cmd.panel.skills"),
    body: `<div class="cmd-sheet-prose">${t("needs.loading")}</div>
      <div class="cmd-sheet-acts" id="cmdSkillActs">
        ${api.auth.canWrite ? `<button class="cmd-mini-btn ember" id="cmdSkillRun">${icon("play")} ${t("cmd.runSkill")}</button>` : ""}
        <a class="cmd-mini-btn" href="#/tools">${t("nav.tools")}</a>
      </div>`,
  });
  if (!panel) return;
  panel.querySelector("#cmdSkillRun")?.addEventListener("click", () => runSkill(name.replace(/^\//, "")));
  const prose = panel.querySelector(".cmd-sheet-prose");
  api.skills.content(name.replace(/^\//, "")).then((data) => {
    if (!prose) return;
    prose.textContent = data.content ?? data.skill?.content ?? JSON.stringify(data, null, 2);
    const enabled = data.enabled ?? data.skill?.enabled;
    if (typeof enabled === "boolean" && api.auth.canAdmin) {
      const acts = panel.querySelector("#cmdSkillActs");
      const button = document.createElement("button");
      button.className = "cmd-mini-btn ember";
      button.textContent = t(enabled ? "cmd.skillDisable" : "cmd.skillEnable");
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await api.skills.toggle(name.replace(/^\//, ""), !enabled);
          toast("success", t("dash.refreshed"));
          openSkillSheet(root, argName);
        } catch (error) {
          button.disabled = false;
          toast("error", error.message);
        }
      });
      acts?.prepend(button);
    }
  }).catch((error) => { if (prose) prose.textContent = error.message; });
}

// --- systems: what the dissolved ops dashboard uniquely knew — services,
// host, backup, the database migration — behind the LED row ---

const gb = (bytes) => `${(bytes / (1024 ** 3)).toFixed(bytes >= 100 * 1024 ** 3 ? 0 : 1)} GB`;
const ago = (raw) => {
  const stamp = parseStamp(raw);
  return stamp ? timeAgo(stamp) : t("dash.never");
};

function databaseDetail(state) {
  if (state.level === "off") return t("dash.db.disabled");
  if (state.level === "ok") return `${t(state.source === "postgres" ? "dash.db.postgres" : "dash.db.hybrid")} · ${t("dash.db.synced", { when: state.lastSuccessAt ? ago(state.lastSuccessAt) : t("dash.never") })}`;
  return state.reasons.map((reason) => t(`dash.db.reason.${reason.code}`, { value: reason.value })).join(" · ");
}

function systemsRow(ok, name, detail) {
  return `<div class="cmd-sheet-row">
    <span class="cmd-subdot ${ok ? "" : "blocked"}"></span>
    <div class="cmd-sheet-row-body"><strong>${esc(name)}</strong><small>${esc(detail)}</small></div>
  </div>`;
}

function meterRow(label, valueText, pct) {
  const width = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<div class="cmd-sheet-row">
    <div class="cmd-sheet-row-body">
      <strong>${esc(label)} <em class="cmd-meter-val mono">${esc(valueText)}</em></strong>
      <span class="cmd-meter"><i style="width:${width}%"></i></span>
    </div>
  </div>`;
}

async function renderSystemsSheet(panel) {
  const body = sheetBody(panel);
  if (!body) return;
  const [operations, health] = await Promise.all([
    bounded(api.operations.status(), null, 6000),
    bounded(api.healthNow(), api.health || {}, 3500),
  ]);
  if (!sheetBody(panel)) return;
  const data = cmdState || {};
  const host = data.pulse?.host || {};
  const backup = operations?.backup || {};
  const drill = operations?.restoreDrill || {};
  const readiness = operations?.readiness || { score: 0, sections: [] };
  const database = databaseHealth(health?.database);
  body.innerHTML = `
    <span class="cmd-subhead">${t("cmd.systems")}</span>
    ${systemsRow(!!data.hermes?.ready, "Hermes", t(data.hermes?.ready ? "dash.svc.bridgeReady" : "dash.svc.unreachable"))}
    ${systemsRow(!!data.mila?.ok, "MILA", data.mila?.ok ? (data.mila.liveModel || t("dash.svc.voiceReady")) : t("dash.svc.unavailable"))}
    ${systemsRow(!!data.claude?.ready, "Claude", data.claude?.ready ? (data.claude.model?.resolved || t("dash.svc.authenticated")) : t("dash.svc.unavailable"))}
    ${systemsRow(!!data.knowledge?.ready, "Vault", t("dash.svc.notes", { count: data.knowledge?.notes || 0 }))}
    ${systemsRow(backup.status === "success", t("dash.svc.backup"), backup.status === "success" ? ago(backup.lastSuccessAt) : (backup.status || t("dash.svc.notVerified")))}
    ${systemsRow(database.level === "ok" || database.level === "off", t("dash.svc.database"), databaseDetail(database))}
    ${systemsRow(drill.status === "success", t("dash.restoreDrill"), drill.status || t("dash.neverRun"))}
    ${host.disk || host.memory || host.cpu ? `<span class="cmd-subhead">${t("dash.host")}</span>` : ""}
    ${host.disk ? meterRow(t("dash.svc.disk"), `${gb(host.disk.totalBytes - host.disk.freeBytes)} / ${gb(host.disk.totalBytes)}`, host.disk.usedPct) : ""}
    ${host.memory ? meterRow(t("dash.memory"), `${gb(host.memory.totalBytes - host.memory.freeBytes)} / ${gb(host.memory.totalBytes)}`, host.memory.usedPct) : ""}
    ${host.cpu ? meterRow(t("dash.cpu", { cores: host.cpu.cores }), `${host.cpu.loadPct}%`, host.cpu.loadPct) : ""}
    ${readiness.sections?.length ? `<span class="cmd-subhead">Four C · ${esc(String(readiness.score || 0))}%</span>
      ${readiness.sections.map((section) => meterRow(section.label, `${section.score}%`, section.score)).join("")}` : ""}
    <div class="cmd-sheet-acts" style="margin-top:10px"><a class="cmd-mini-btn" href="#/observability">${t("nav.observability")}</a></div>`;
}

function openSystemsSheet(root) {
  const panel = openSheet(root, {
    name: "systems", ico: "observability", title: t("cmd.systems"), subtitle: t("dash.probes"),
    body: `<div class="cmd-empty">${t("needs.loading")}</div>`,
  });
  if (panel) renderSystemsSheet(panel);
}

// --- erp: the factory's morning question, answered without leaving the stage ---

async function renderErpSheet(panel) {
  const body = sheetBody(panel);
  if (!body) return;
  const cached = cmdErp && Date.now() - cmdErp.at < ERP_TTL;
  const snapshot = cached ? cmdErp.data : await bounded(api.erp.snapshot(), null, 12000);
  if (snapshot && !cached) cmdErp = { data: snapshot, at: Date.now() };
  if (!sheetBody(panel)) return;
  if (!snapshot) { body.innerHTML = `<div class="cmd-empty">${t("dash.svc.unreachable")}</div>`; return; }
  if (!snapshot.configured) { body.innerHTML = `<div class="cmd-empty">${t("erp.tokenMissing")}</div>`; return; }
  const digest = erpDigest(snapshot);
  if (erpSilent(snapshot, digest)) { body.innerHTML = `<div class="cmd-empty">${t("dash.svc.unreachable")}</div>`; return; }
  const num = new Intl.NumberFormat(getLocale());
  const row = (label, valueText, tone = "") => `<div class="cmd-sheet-row">
    <div class="cmd-sheet-row-body"><strong>${esc(label)}</strong></div>
    <span class="cmd-erp-val ${tone}">${esc(valueText)}</span>
  </div>`;
  body.innerHTML = `
    <span class="cmd-subhead">${t("erp.production")}</span>
    ${row(t("erp.productionOutput"), num.format(digest.productionOutput))}
    ${digest.cuttingOutput ? row(t("erp.cutting"), num.format(digest.cuttingOutput)) : ""}
    ${digest.printingOutput ? row(t("erp.printing"), num.format(digest.printingOutput)) : ""}
    ${digest.sewingOutput ? row(t("erp.sewing"), num.format(digest.sewingOutput)) : ""}
    ${digest.packagingOutput ? row(t("erp.packaging"), num.format(digest.packagingOutput)) : ""}
    ${row(t("erp.activeOrders"), num.format(digest.activeOrders))}
    ${digest.reworkQty ? row(t("erp.rework"), num.format(digest.reworkQty), "risk") : ""}
    ${row(t("erp.lateOrders"), num.format(digest.lateOrders), digest.lateOrders ? "risk" : "")}
    <span class="cmd-subhead">${t("erp.finishedGoods")}</span>
    ${row(t("erp.finishedGoodsPieces"), num.format(digest.readyPieces))}
    ${digest.revenue || digest.stockValue ? `<span class="cmd-subhead">${t("erp.finance")}</span>
      ${digest.revenue ? row(t("erp.revenue"), num.format(digest.revenue)) : ""}
      ${digest.stockValue ? row(t("erp.stockValue"), num.format(digest.stockValue)) : ""}` : ""}
    <div class="cmd-sheet-acts" style="margin-top:10px"><a class="cmd-mini-btn" href="#/erp">${t("nav.erp")}</a></div>`;
}

function openErpSheet(root) {
  const panel = openSheet(root, {
    name: "erp", ico: "activity", title: t("cmd.panel.erp"), subtitle: "Milana ERP",
    body: `<div class="cmd-empty">${t("needs.loading")}</div>`,
  });
  if (panel) renderErpSheet(panel);
}

const SHEETS = { inbox: openInboxSheet, routines: openRoutinesSheet, today: openTodaySheet, note: openNoteSheet, skill: openSkillSheet, systems: openSystemsSheet, erp: openErpSheet };
const openSheetByName = (root, name, arg) => SHEETS[name]?.(root, arg);

const isMapRoute = (ctx) => ctx?.params?.[0] === "map" || location.hash.split("/")[2] === "map";
const mapFocus = (ctx) => decodeURIComponent(ctx?.params?.[1] || location.hash.split("/")[3] || "");

export default {
  get title() { return t("nav.command"); },
  render(ctx) {
    return isMapRoute(ctx) ? mapHTML(cmdState, mapFocus(ctx) ? encodeURIComponent(mapFocus(ctx)) : "") : stageHTML(cmdState);
  },
  mount(root, ctx) {
    const map = isMapRoute(ctx);
    const canvas = root.querySelector("#cmdScene");
    const stage = root.querySelector(".cmd-stage");

    if (map) {
      const field = root.querySelector("#cmdMapField");
      if (field && canvas) {
        sceneStop = startMapScene(canvas, field, {
          domains: domainsFrom(cmdState?.graph?.nodes),
          edges: cmdState?.graph?.edges || [],
          routines: (cmdState?.routines || []).length,
          focus: mapFocus(ctx) ? encodeURIComponent(mapFocus(ctx)) : "",
          onNote: (note) => openNoteSheet(root, encodeURIComponent(note.id), note),
        });
        const fit = () => {
          const box = field.getBoundingClientRect();
          stage.style.setProperty("--cmd-R", `${Math.round(Math.min(box.width, box.height) / 2 - 44)}px`);
        };
        fit();
        const watcher = new ResizeObserver(() => requestAnimationFrame(fit));
        watcher.observe(field);
        window.addEventListener("resize", fit);
        stageWatch = { disconnect() { watcher.disconnect(); window.removeEventListener("resize", fit); } };
      }
      const legendBtn = root.querySelector("#cmdLegendBtn");
      const legend = root.querySelector("#cmdLegend");
      if (legendBtn && legend) legendBtn.addEventListener("click", () => { legend.hidden = !legend.hidden; });
    } else {
      const orbit = root.querySelector("#cmdOrbit");
      if (orbit && canvas) sceneStop = startDashboardScene(canvas, orbit, { domains: domainsFrom(cmdState?.graph?.nodes) });
      // The ring has to clear whatever shares the stage with it: the side
      // columns and the brand in HUD mode, the orbit block's own box below it.
      if (stage && orbit) {
        const fit = () => {
          const hud = window.matchMedia("(min-width: 1281px)").matches;
          const box = (hud ? stage : orbit).getBoundingClientRect();
          const radius = hud
            ? Math.max(170, Math.min((box.width - 700) / 2 - 34, box.height / 2 - 100, 430))
            : Math.max(96, Math.min(box.width, box.height) / 2 - 46);
          stage.style.setProperty("--cmd-r", `${Math.round(radius)}px`);
        };
        fit();
        // The observer alone misses the HUD/flow flip: the media query can
        // settle after the boxes report their old size, so the window
        // listener re-fits.
        const watcher = new ResizeObserver(() => requestAnimationFrame(fit));
        watcher.observe(stage);
        watcher.observe(orbit);
        window.addEventListener("resize", fit);
        stageWatch = { disconnect() { watcher.disconnect(); window.removeEventListener("resize", fit); } };
      }
      wireBrainSearch(root);
      root.querySelectorAll("[data-sheet]").forEach((button) =>
        button.addEventListener("click", () => openSheetByName(root, button.dataset.sheet)));
      root.querySelectorAll("[data-run-skill]").forEach((button) =>
        button.addEventListener("click", () => runSkill(button.dataset.runSkill)));
      root.querySelectorAll("[data-open-skill]").forEach((button) =>
        button.addEventListener("click", () => openSkillSheet(root, encodeURIComponent(button.dataset.openSkill))));
      // Deep link: #/command/sheet/<name>[/arg] arrives here as params.
      const parts = ctx?.params?.length ? ctx.params : location.hash.split("/").slice(2);
      if (parts[0] === "sheet" && parts[1]) openSheetByName(root, parts[1], parts.slice(2).join("/"));
      clockTimer = setInterval(() => {
        const hm = root.querySelector("#cmdClockHm");
        if (!hm) return;
        const now = new Date();
        const clock = clockParts(now);
        hm.textContent = clock.hm;
        const s = root.querySelector("#cmdClockS");
        if (s) s.textContent = `:${clock.s}`;
        const ap = root.querySelector("#cmdClockAp");
        if (ap) ap.textContent = clock.ap ? ` ${clock.ap}` : "";
        const hand = (id, deg) => {
          const el = root.querySelector(`#${id}`);
          if (el) el.setAttribute("transform", `rotate(${deg} 22 22)`);
        };
        hand("cmdAnH", (now.getHours() % 12) * 30 + now.getMinutes() * 0.5);
        hand("cmdAnM", now.getMinutes() * 6 + now.getSeconds() * 0.1);
        hand("cmdAnS", now.getSeconds() * 6);
        root.querySelectorAll("[data-zone]").forEach((cell) => {
          const zone = cell.dataset.zone;
          const wc = clockParts(now, zone);
          const strong = cell.querySelector("b");
          if (strong) strong.textContent = `${wc.hm}${wc.ap ? ` ${wc.ap}` : ""}`;
        });
      }, 1000);
    }

    if (!cmdState && !cmdLoading) loadCommand();
    cmdPoll = setInterval(() => loadCommand(true), 45000);
  },
  unmount() {
    clearInterval(cmdPoll);
    cmdPoll = null;
    clearInterval(clockTimer);
    clockTimer = null;
    sceneStop?.();
    sceneStop = null;
    stageWatch?.disconnect();
    stageWatch = null;
    sheetClose?.();
  },
};
