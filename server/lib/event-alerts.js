// "Через 15 минут — совещание": the warning before a calendar event.
//
// The morning brief says what the day holds at eight; nothing then reminds the
// owner at five to noon. Every few minutes this looks a short way ahead in
// each connected calendar and pings once per event when its start enters the
// warning window — through the inbox, so a linked Telegram gets it too.
//
// Once means once: alerts are recorded per user and event and survive a
// restart, because двойное "через 15 минут" is nagging, and a restart at 11:50
// must not re-warn about the noon meeting. All-day events are skipped — there
// is no meaningful "15 minutes before" a day.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { creatorUser } from "./auth.js";
import { googleWorkspace } from "./google-workspace.js";
import { onboarding } from "./onboarding.js";
import { pushService } from "./push-service.js";
import { hardenRuntimeFile } from "./runtime-files.js";
import { users } from "./users.js";

const TICK_MS = 5 * 60 * 1000;
const WARN_MINUTES = 15;
// Look far enough ahead that a 5-minute tick cannot step over the window, and
// no further: warning at 11:20 about a noon meeting is a to-do list, not a nudge.
const LOOKAHEAD_MS = (WARN_MINUTES + 6) * 60 * 1000;
const KEEP_DAYS = 2;

const clean = (value, max) => String(value ?? "").trim().slice(0, max);

export function createEventAlerts(options = {}) {
  const calendar = options.googleWorkspace || googleWorkspace;
  const push = options.pushService || pushService;
  const settings = options.onboarding || onboarding;
  const directory = options.users || users;
  const creator = options.creatorUser || creatorUser;
  const now = options.now || (() => new Date());
  const file = options.file || path.join(path.resolve(config.dataDir), "event-alerts.json");
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

  function minutesLabel(minutes) {
    if (minutes <= 1) return "прямо сейчас";
    return `через ${minutes} мин`;
  }

  async function tick() {
    const current = now();
    const state = read();
    const alerted = state.alerted || {};
    const sent = [];

    const candidates = [creator(), ...(directory.list?.() || [])]
      .filter((user) => user?.id && !user.disabled && user.approved !== false);
    for (const user of candidates) {
      try {
        const profile = settings.get(user).profile || {};
        if (!profile.completedAt) continue;
        if (!calendar.status(user.id).connected) continue;
        const feed = await calendar.calendarEvents(user.id, {
          from: current,
          to: new Date(current.getTime() + LOOKAHEAD_MS),
          limit: 10,
        });
        for (const event of feed.events || []) {
          if (event.allDay) continue;
          const start = new Date(event.start);
          if (Number.isNaN(start.getTime())) continue;
          const minutesLeft = Math.round((start.getTime() - current.getTime()) / 60000);
          if (minutesLeft > WARN_MINUTES || minutesLeft < 0) continue;
          const key = `${user.id}:${clean(event.id, 80) || event.start}`;
          if (alerted[key]) continue;
          alerted[key] = current.toISOString();
          const title = clean(event.title, 120) || "Событие в календаре";
          await push.sendInbox(user.id, {
            id: `event_${clean(event.id, 60) || start.getTime()}`,
            kind: "event-alert",
            title: `${minutesLabel(minutesLeft)}: ${title}`,
            body: `Начало в ${start.toLocaleTimeString("ru-RU", { timeZone: profile.timezone || "Asia/Tashkent", hour: "2-digit", minute: "2-digit" })}${event.location ? ` · ${clean(event.location, 80)}` : ""}`,
          });
          sent.push(key);
        }
      } catch { /* one user's broken calendar must not silence the rest */ }
    }

    // Old keys age out so the file does not grow one line per meeting forever.
    const horizon = current.getTime() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const [key, at] of Object.entries(alerted)) {
      if (new Date(at).getTime() < horizon) delete alerted[key];
    }
    if (sent.length || Object.keys(alerted).length !== Object.keys(state.alerted || {}).length) {
      write({ alerted });
    }
    return sent;
  }

  function start() {
    if (timer) return;
    const run = () => tick().catch((error) => console.warn(`[event-alerts] ${error.message}`)).finally(() => { timer = setTimeout(run, TICK_MS); });
    timer = setTimeout(run, TICK_MS);
  }

  return { tick, start, stop: () => { clearTimeout(timer); timer = null; } };
}

export const eventAlerts = createEventAlerts();
