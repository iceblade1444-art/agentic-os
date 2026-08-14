// The briefing that arrives before the day starts.
//
// Once per local morning it builds the same day plan the Personal page shows,
// writes it into the inbox and pushes it to the phone. It fires per user in that
// user's own timezone, and records the local date it last covered so a restart,
// a second worker or a clock adjustment cannot deliver the same morning twice.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { creatorUser } from "./auth.js";
import { memberWorkspaces } from "./member-workspace.js";
import { broadcaster } from "./messenger-broadcast.js";
import { onboarding } from "./onboarding.js";
import { dayPlanFor } from "./personal-day.js";
import { planningInternals, spokenPlan } from "./personal-planner.js";
import { pushService } from "./push-service.js";
import { hardenRuntimeFile } from "./runtime-files.js";
import { users } from "./users.js";
import { personalProfiles } from "./personal-profile.js";

const TICK_MS = 5 * 60 * 1000;
// A brief that missed its slot by more than this is stale: the owner is already
// working, and a "good morning" at 14:00 is noise.
const LATE_TOLERANCE_MINUTES = 180;

const pad = (value) => String(value).padStart(2, "0");

function localMinutes(now, timeZone) {
  const parts = planningInternals.zonedParts(now, timeZone);
  return parts.hour * 60 + parts.minute;
}

function parseClock(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

// Plain text, no markdown: it is read on a phone notification and by MILA aloud.
export function briefBody(plan) {
  const lines = [plan.summary];
  const agenda = (plan.agenda || []).slice(0, 6);
  for (const item of agenda) {
    const time = item.allDay
      ? "весь день"
      : `${planningInternals.localTimeLabel(new Date(item.start), plan.timezone)}`;
    lines.push(`${time} — ${item.title}`);
  }
  const high = (plan.alerts || []).filter((alert) => alert.level === "high").slice(0, 3);
  for (const alert of high) lines.push(`⚠ ${alert.title}`);
  if (!agenda.length && !high.length) lines.push("Календарь свободен, срочного нет.");
  return lines.join("\n");
}

export class MorningBrief {
  constructor(file = path.join(path.resolve(config.dataDir), "morning-brief.json")) {
    this.file = file;
    this.timer = null;
  }

  #read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  #write(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
    hardenRuntimeFile(this.file, 0o600);
  }

  lastSent(userId) {
    return this.#read()[userId]?.date || "";
  }

  // Exposed so the UI can offer "send it now" without waiting for tomorrow.
  async sendFor(user, deps = {}, now = new Date()) {
    const workspaces = deps.memberWorkspaces || memberWorkspaces;
    const push = deps.pushService || pushService;
    const buildPlan = deps.dayPlanFor || dayPlanFor;
    // Nobody is waiting on the brief, and it is always the first ERP read of the
    // day — the slowest one, since the MCP connection and login have gone cold
    // overnight. Give it room rather than shipping a day plan with ERP missing.
    const plan = await buildPlan(user, { now, erpTimeoutMs: 20000 });
    // Standing commitments from the private profile ride only in the personal
    // delivery. The brief can also be posted to a team channel below, and what
    // someone told MILA about their own obligations is not channel material —
    // the same audience rule as everywhere else.
    const profiles = deps.personalProfiles || personalProfiles;
    const commitments = profiles.list(user.id, { category: "commitments" }).slice(0, 3);
    const channelBody = briefBody(plan);
    const personalBody = commitments.length
      ? `${channelBody}\n\nВаши обязательства:\n${commitments.map((fact) => `• ${fact.text}`).join("\n")}`
      : channelBody;
    const item = workspaces.createInboxItem(user.id, {
      type: "reminder",
      title: `План на ${plan.date}`,
      body: personalBody,
      priority: (plan.alerts || []).some((alert) => alert.level === "high") ? "high" : "normal",
      source: "system",
      route: "#/personal",
    });
    await push.sendInbox(user.id, item);

    // The brief is also team news when the owner has pointed it at a channel:
    // the people who can act on a late order are already talking there.
    const channels = deps.broadcaster || broadcaster;
    const channelName = channels.briefChannel(user);
    if (channelName) {
      try {
        channels.post(channelName, `**${item.title}**\n${channelBody}`, { onBehalfOf: user });
      } catch (error) {
        console.error(`[morning-brief] could not post to ${channelName}: ${error.message}`);
      }
    }

    const state = this.#read();
    state[user.id] = { date: plan.date, sentAt: new Date(now).toISOString() };
    this.#write(state);
    return { plan, item, spoken: spokenPlan(plan) };
  }

  due(user, profile, now) {
    if (profile.briefEnabled === false) return false;
    const timeZone = profile.timezone || "Asia/Tashkent";
    const parts = planningInternals.zonedParts(now, timeZone);
    const today = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    if (this.lastSent(user.id) === today) return false;
    const target = parseClock(profile.briefTime, 8 * 60);
    const current = localMinutes(now, timeZone);
    return current >= target && current - target <= LATE_TOLERANCE_MINUTES;
  }

  async run(now = new Date(), deps = {}) {
    const directory = deps.users || users;
    const store = deps.onboarding || onboarding;
    const owner = deps.creatorUser ? deps.creatorUser() : creatorUser();
    const sent = [];
    // The Creator lives in server configuration rather than the user store, so
    // enumerating only the store would skip the one person who needs this most.
    const candidates = [owner, ...(directory.list?.() || [])]
      .filter((user) => user?.id && !user.disabled && user.approved !== false);
    for (const user of candidates) {
      try {
        const profile = store.get(user).profile || {};
        if (!profile.completedAt) continue;
        if (!this.due(user, profile, now)) continue;
        await this.sendFor(user, deps, now);
        sent.push(user.id);
      } catch (error) {
        console.error(`[morning-brief] failed for ${user.id}: ${error.message}`);
      }
    }
    return sent;
  }

  start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      this.run().catch((error) => console.error(`[morning-brief] tick failed: ${error.message}`));
    }, TICK_MS);
    this.timer.unref?.();
    return this.timer;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const morningBrief = new MorningBrief();
