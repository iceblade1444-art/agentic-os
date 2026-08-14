// The evening close of the day — the morning brief's mirror.
//
// Half an hour after the workday ends, each person gets one short message:
// what they closed today, what stayed open, and what tomorrow starts with. It
// leaves through the inbox, so a linked Telegram receives it too. Everything
// in it is their own — their tasks, their reminders, their calendar — built
// from the same stores the Personal page shows, so the summary can never know
// more than the screen does.
//
// Same discipline as the morning brief: once per local day, skipped entirely
// when the slot is missed by hours (a "вечерний итог" at midnight is noise),
// and the Creator is enumerated from configuration because the user store does
// not hold them.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { creatorUser } from "./auth.js";
import { googleWorkspace } from "./google-workspace.js";
import { memberWorkspaces } from "./member-workspace.js";
import { onboarding } from "./onboarding.js";
import { planningInternals } from "./personal-planner.js";
import { pushService } from "./push-service.js";
import { reminders } from "./reminders.js";
import { hardenRuntimeFile } from "./runtime-files.js";
import { users } from "./users.js";

const TICK_MS = 5 * 60 * 1000;
const AFTER_WORKDAY_MINUTES = 30;
const LATE_TOLERANCE_MINUTES = 150;
const pad = (value) => String(value).padStart(2, "0");
const clean = (value, max) => String(value ?? "").trim().slice(0, max);

function parseClock(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

function localMinutes(now, timeZone) {
  const parts = planningInternals.zonedParts(now, timeZone);
  return parts.hour * 60 + parts.minute;
}

export function createEveningSummary(options = {}) {
  const file = options.file || path.join(path.resolve(config.dataDir), "evening-summary.json");
  const workspaces = options.memberWorkspaces || memberWorkspaces;
  const reminderStore = options.reminders || reminders;
  const calendar = options.googleWorkspace || googleWorkspace;
  const push = options.pushService || pushService;
  const settings = options.onboarding || onboarding;
  const directory = options.users || users;
  const creator = options.creatorUser || creatorUser;
  let timer = null;

  const read = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  const write = (value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    hardenRuntimeFile(file, 0o600);
  };

  function localDay(now, timeZone) {
    const parts = planningInternals.zonedParts(now, timeZone);
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  }

  async function compose(user, profile, now) {
    const timeZone = profile.timezone || "Asia/Tashkent";
    const today = localDay(now, timeZone);
    const tasks = workspaces.listTasks(user.id);
    const doneToday = tasks.filter((task) => task.status === "done" && String(task.updatedAt || "").startsWith(today));
    const open = tasks.filter((task) => task.status !== "done");

    const lines = [];
    lines.push(doneToday.length
      ? `Закрыто сегодня: ${doneToday.length} — ${doneToday.slice(0, 3).map((task) => clean(task.title, 60)).join("; ")}${doneToday.length > 3 ? "…" : ""}`
      : "Сегодня ни одна задача не закрыта.");
    if (open.length) lines.push(`Открыто: ${open.length}${open.some((task) => task.priority === "high") ? " (есть срочные)" : ""}`);

    // Tomorrow starts with: the first calendar event, then reminders due
    // tomorrow. Both are optional and both fail silently into absence — an
    // evening summary must never crash on a disconnected calendar.
    const tomorrow = new Date(new Date(`${today}T00:00:00Z`).getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    try {
      if (calendar.status(user.id).connected) {
        const feed = await calendar.calendarEvents(user.id, {
          from: new Date(`${today}T18:00:00Z`),
          to: new Date(`${tomorrow}T23:59:59Z`),
          limit: 5,
        });
        const first = (feed.events || []).find((event) => String(event.start || "").slice(0, 10) === tomorrow);
        if (first) lines.push(`Завтра первым: ${clean(first.title, 80)}${first.start?.length > 10 ? ` в ${String(first.start).slice(11, 16)}` : ""}`);
      }
    } catch { /* calendar unavailable — absent, not invented */ }
    const dueTomorrow = reminderStore.list(user.id).filter((item) => String(item.dueAt || "").slice(0, 10) === tomorrow);
    if (dueTomorrow.length) lines.push(`Напоминаний на завтра: ${dueTomorrow.length}`);

    return { title: "Итог дня", body: lines.join("\n"), date: today };
  }

  function due(userId, profile, now, state) {
    if (profile.eveningSummaryEnabled === false) return false;
    const timeZone = profile.timezone || "Asia/Tashkent";
    if (state[userId]?.date === localDay(now, timeZone)) return false;
    const target = parseClock(profile.workdayEnd, 18 * 60) + AFTER_WORKDAY_MINUTES;
    const current = localMinutes(now, timeZone);
    return current >= target && current - target <= LATE_TOLERANCE_MINUTES;
  }

  async function run(now = new Date()) {
    const state = read();
    const candidates = [creator(), ...(directory.list?.() || [])]
      .filter((user) => user?.id && !user.disabled && user.approved !== false);
    const sent = [];
    for (const user of candidates) {
      try {
        const profile = settings.get(user).profile || {};
        if (!profile.completedAt) continue;
        if (!due(user.id, profile, now, state)) continue;
        const item = await compose(user, profile, now);
        await push.sendInbox(user.id, { id: `evening_${item.date}_${user.id}`, kind: "evening-summary", ...item });
        state[user.id] = { date: item.date, sentAt: now.toISOString() };
        sent.push(user.id);
      } catch (error) {
        console.error(`[evening-summary] failed for ${user.id}: ${error.message}`);
      }
    }
    if (sent.length) write(state);
    return sent;
  }

  function start() {
    if (timer) return;
    const tick = () => run().catch((error) => console.warn(`[evening-summary] ${error.message}`)).finally(() => { timer = setTimeout(tick, TICK_MS); });
    timer = setTimeout(tick, TICK_MS);
  }

  return { run, compose, due, start, stop: () => { clearTimeout(timer); timer = null; } };
}

export const eveningSummary = createEveningSummary();
