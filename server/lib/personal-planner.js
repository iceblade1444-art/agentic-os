// Builds the actual plan for the user's day.
//
// The old briefing was three sentences stitched from counts. A personal assistant
// has to be more concrete than that: it merges the calendar, open tasks, approvals
// waiting on the owner and live ERP flags into one timeline, puts focus work into
// the gaps between meetings, and states plainly what will not fit. Everything here
// is pure so both the Personal page and MILA read the identical plan.

const DEFAULT_TIMEZONE = "Asia/Tashkent";
const DEFAULT_WORKDAY = { start: "09:00", end: "18:00" };
const LUNCH = { start: "13:00", end: "14:00" };
const MIN_FOCUS_MINUTES = 25;
const FOCUS_MINUTES = { high: 60, normal: 45, low: 30 };
const MAX_FOCUS_BLOCKS = 5;
const MINUTE = 60 * 1000;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const clean = (value, max = 200) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);

function formatter(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    return formatter(DEFAULT_TIMEZONE);
  }
}

function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
  };
}

// Offset between the wall clock in `timeZone` and UTC at that instant, in ms.
function zoneOffset(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

// Wall-clock time in `timeZone` -> instant. Applied twice so a DST shift inside the
// guessed offset still lands on the right moment.
function instantFromLocal(timeZone, { year, month, day, hour = 0, minute = 0 }) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = zoneOffset(new Date(guess), timeZone);
  const candidate = guess - first;
  const second = zoneOffset(new Date(candidate), timeZone);
  return new Date(second === first ? candidate : guess - second);
}

function parseClock(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clean(value, 5));
  if (!match) return fallback;
  const hour = clamp(Number(match[1]), 0, 23);
  const minute = clamp(Number(match[2]), 0, 59);
  return { hour, minute };
}

const clockOf = (value, fallback) => parseClock(value, parseClock(fallback, { hour: 9, minute: 0 }));

function localDateKey(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function localTimeLabel(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function greetingPeriod(hour) {
  if (hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "day";
  return "evening";
}

function eventWindow(event, timeZone, dayStart, dayEnd) {
  if (event.allDay) return { start: dayStart, end: dayEnd, allDay: true };
  const start = new Date(event.start);
  const end = new Date(event.end || event.start);
  if (Number.isNaN(start.getTime())) return null;
  return {
    start,
    end: Number.isNaN(end.getTime()) || end <= start ? new Date(start.getTime() + 30 * MINUTE) : end,
    allDay: false,
  };
}

function todaysEvents(events, timeZone, dayStart, dayEnd) {
  return (events || [])
    .map((event) => {
      const window = eventWindow(event, timeZone, dayStart, dayEnd);
      if (!window) return null;
      if (window.end <= dayStart || window.start >= dayEnd) return null;
      return {
        id: clean(event.id, 160) || `evt_${window.start.getTime()}`,
        kind: "event",
        title: clean(event.title, 160) || "Событие",
        detail: clean(event.location || event.description, 200),
        start: window.start.toISOString(),
        end: window.end.toISOString(),
        allDay: window.allDay,
        source: "calendar",
        link: clean(event.htmlLink, 400),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start.localeCompare(b.start));
}

function conflictsIn(events) {
  const conflicts = [];
  const timed = events.filter((event) => !event.allDay);
  for (let i = 1; i < timed.length; i += 1) {
    const previous = timed[i - 1];
    const current = timed[i];
    if (current.start < previous.end) conflicts.push({ first: previous.title, second: current.title, at: current.start });
  }
  return conflicts;
}

// Free stretches of the working day, minus meetings and the lunch window.
function freeSlots(events, dayStart, dayEnd, busyExtra = []) {
  const busy = [...events.filter((event) => !event.allDay), ...busyExtra]
    .map((item) => ({ start: new Date(item.start), end: new Date(item.end) }))
    .sort((a, b) => a.start - b.start);
  const slots = [];
  let cursor = dayStart;
  for (const block of busy) {
    if (block.start > cursor) slots.push({ start: cursor, end: block.start });
    if (block.end > cursor) cursor = block.end;
  }
  if (cursor < dayEnd) slots.push({ start: cursor, end: dayEnd });
  return slots.filter((slot) => slot.end - slot.start >= MIN_FOCUS_MINUTES * MINUTE);
}

function taskWeight(task, today) {
  const overdue = task.dueDate && task.dueDate < today ? 3 : 0;
  const dueToday = task.dueDate === today ? 2 : 0;
  const priority = task.priority === "high" ? 2 : task.priority === "low" ? -1 : 0;
  const doing = task.status === "doing" ? 1 : 0;
  return overdue + dueToday + priority + doing;
}

function scheduleTasks(tasks, slots, today) {
  const queue = [...tasks]
    .filter((task) => task.status !== "done")
    .sort((a, b) => taskWeight(b, today) - taskWeight(a, today)
      || String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")));
  const blocks = [];
  const unplaced = [];
  const open = slots.map((slot) => ({ start: new Date(slot.start), end: new Date(slot.end) }));

  for (const task of queue) {
    if (blocks.length >= MAX_FOCUS_BLOCKS) { unplaced.push(task); continue; }
    const minutes = FOCUS_MINUTES[task.priority] || FOCUS_MINUTES.normal;
    const slot = open.find((item) => item.end - item.start >= MIN_FOCUS_MINUTES * MINUTE);
    if (!slot) { unplaced.push(task); continue; }
    const available = Math.floor((slot.end - slot.start) / MINUTE);
    const length = Math.min(minutes, available);
    const start = new Date(slot.start);
    const end = new Date(start.getTime() + length * MINUTE);
    slot.start = end;
    blocks.push({
      id: `focus_${task.id}`,
      kind: "focus",
      title: task.title,
      detail: clean(task.detail, 200),
      start: start.toISOString(),
      end: end.toISOString(),
      allDay: false,
      source: "task",
      taskId: task.id,
      priority: task.priority,
      dueDate: task.dueDate || "",
    });
  }
  return { blocks, unplaced };
}

function erpAlerts(erp = {}) {
  const alerts = [];
  // A read that ran out of time is not the same as no ERP at all. Staying silent
  // here would hide a late order behind an otherwise clean-looking day.
  if (erp?.timedOut) {
    return [{
      id: "erp_timeout",
      level: "normal",
      source: "erp",
      title: "Данные ERP не успели загрузиться",
      detail: "Просроченные заказы и склад не проверены. Нажмите «Пересобрать».",
      route: "#/erp",
    }];
  }
  if (!erp || erp.available === false) return alerts;
  const late = Number(erp.lateOrders);
  if (Number.isFinite(late) && late > 0) {
    alerts.push({
      id: "erp_late_orders",
      level: "high",
      source: "erp",
      title: `Просроченных заказов: ${late}`,
      detail: clean(erp.lateOrdersDetail, 240),
      route: "#/erp",
    });
  }
  if (erp.financeFlag) {
    alerts.push({ id: "erp_finance", level: "normal", source: "erp", title: clean(erp.financeFlag, 160), route: "#/erp" });
  }
  for (const item of Array.isArray(erp.flags) ? erp.flags.slice(0, 4) : []) {
    alerts.push({
      id: clean(item.id, 60) || `erp_flag_${alerts.length}`,
      level: item.level === "high" ? "high" : "normal",
      source: "erp",
      title: clean(item.title, 160),
      detail: clean(item.detail, 240),
      route: "#/erp",
    });
  }
  return alerts.filter((alert) => alert.title);
}

export function buildDayPlan({
  user = {},
  profile = {},
  tasks = [],
  events = [],
  approvals = [],
  erp = null,
  now = new Date(),
} = {}) {
  const timeZone = clean(profile.timezone, 80) || DEFAULT_TIMEZONE;
  const parts = zonedParts(now, timeZone);
  const today = localDateKey(now, timeZone);
  const workday = {
    start: clockOf(profile.workdayStart, DEFAULT_WORKDAY.start),
    end: clockOf(profile.workdayEnd, DEFAULT_WORKDAY.end),
  };
  const dayStart = instantFromLocal(timeZone, { ...parts, ...workday.start });
  const dayEnd = instantFromLocal(timeZone, { ...parts, ...workday.end });
  const lunchStart = instantFromLocal(timeZone, { ...parts, ...clockOf(profile.lunchStart, LUNCH.start) });
  const lunchEnd = instantFromLocal(timeZone, { ...parts, ...clockOf(profile.lunchEnd, LUNCH.end) });

  const dayEvents = todaysEvents(events, timeZone, dayStart, dayEnd);
  // Focus work starts from now, never in an hour that has already passed.
  const planningStart = new Date(Math.max(dayStart.getTime(), now.getTime()));
  const lunchBlock = lunchEnd > lunchStart && lunchEnd > planningStart
    ? [{ start: lunchStart.toISOString(), end: lunchEnd.toISOString() }]
    : [];
  const slots = freeSlots(dayEvents, planningStart, dayEnd, lunchBlock)
    .filter((slot) => slot.end > planningStart);

  const openTasks = (tasks || []).filter((task) => task.status !== "done");
  const overdue = openTasks.filter((task) => task.dueDate && task.dueDate < today);
  const dueToday = openTasks.filter((task) => task.dueDate === today);
  const { blocks, unplaced } = scheduleTasks(openTasks, slots, today);

  const agenda = [...dayEvents, ...blocks].sort((a, b) => a.start.localeCompare(b.start));
  const conflicts = conflictsIn(dayEvents);

  const alerts = [];
  for (const task of overdue.slice(0, 3)) {
    alerts.push({
      id: `overdue_${task.id}`, level: "high", source: "task",
      title: `Просрочена задача: ${task.title}`, detail: `Срок был ${task.dueDate}`, route: "#/my-tasks",
    });
  }
  for (const conflict of conflicts.slice(0, 2)) {
    alerts.push({
      id: `conflict_${conflict.at}`, level: "high", source: "calendar",
      title: "Встречи наложились", detail: `${conflict.first} и ${conflict.second}`, route: "#/personal",
    });
  }
  if (approvals.length) {
    alerts.push({
      id: "approvals", level: "normal", source: "approvals",
      title: `Ожидают подтверждения: ${approvals.length}`,
      detail: clean(approvals[0]?.title || approvals[0]?.description, 200), route: "#/personal/approvals",
    });
  }
  for (const task of unplaced.slice(0, 2)) {
    alerts.push({
      id: `unplaced_${task.id}`, level: "normal", source: "task",
      title: `Не помещается в день: ${task.title}`, detail: "Перенесите срок или освободите время", route: "#/my-tasks",
    });
  }
  alerts.push(...erpAlerts(erp));

  const nextItem = agenda.find((item) => new Date(item.end) > now) || null;
  const load = clamp(
    openTasks.length * 8 + dueToday.length * 12 + overdue.length * 16
      + dayEvents.filter((event) => !event.allDay).length * 9 + approvals.length * 6,
    0, 100,
  );

  const summaryParts = [];
  if (dayEvents.length) summaryParts.push(`встреч сегодня — ${dayEvents.length}`);
  if (dueToday.length) summaryParts.push(`задач со сроком сегодня — ${dueToday.length}`);
  if (overdue.length) summaryParts.push(`просрочено — ${overdue.length}`);
  if (approvals.length) summaryParts.push(`на подтверждении — ${approvals.length}`);
  if (!summaryParts.length) summaryParts.push("срочного ничего нет");

  return {
    date: today,
    timezone: timeZone,
    generatedAt: new Date(now).toISOString(),
    greetingPeriod: greetingPeriod(parts.hour),
    firstName: clean(user.name, 60).split(" ")[0] || "",
    workday: {
      start: dayStart.toISOString(),
      end: dayEnd.toISOString(),
      startLabel: localTimeLabel(dayStart, timeZone),
      endLabel: localTimeLabel(dayEnd, timeZone),
    },
    agenda,
    alerts,
    conflicts,
    next: nextItem,
    unplaced: unplaced.slice(0, 5).map((task) => ({ id: task.id, title: task.title, dueDate: task.dueDate || "" })),
    stats: {
      events: dayEvents.length,
      focusBlocks: blocks.length,
      openTasks: openTasks.length,
      dueToday: dueToday.length,
      overdue: overdue.length,
      approvals: approvals.length,
      freeMinutes: slots.reduce((total, slot) => total + Math.floor((slot.end - slot.start) / MINUTE), 0),
      load,
    },
    summary: `Сегодня: ${summaryParts.join(", ")}.`,
  };
}

// Compact plain-language plan for MILA to read out or paste into chat. Kept free
// of markdown and paths: everything here can be spoken verbatim.
export function spokenPlan(plan, timeZone = plan?.timezone || DEFAULT_TIMEZONE) {
  if (!plan) return "План на день недоступен.";
  const lines = [plan.summary];
  for (const item of plan.agenda.slice(0, 8)) {
    const at = item.allDay ? "весь день" : `${localTimeLabel(new Date(item.start), timeZone)}–${localTimeLabel(new Date(item.end), timeZone)}`;
    lines.push(`${at} — ${item.kind === "focus" ? "работа над задачей" : "встреча"}: ${item.title}`);
  }
  for (const alert of plan.alerts.slice(0, 4)) {
    lines.push(`Важно: ${alert.title}${alert.detail ? `. ${alert.detail}` : ""}`);
  }
  if (!plan.agenda.length) lines.push("В календаре на сегодня пусто, всё рабочее время свободно.");
  return lines.join("\n");
}

export const planningInternals = { instantFromLocal, localDateKey, localTimeLabel, freeSlots, zonedParts };
