// Time-based reminders MILA can set for the owner.
//
// A task with a due date says "today"; a reminder says "at 15:00". The store keeps
// only what has not fired yet plus a short tail of delivered ones, and a single
// ticker drains it into the member inbox, which already pushes to the phone.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { memberWorkspaces } from "./member-workspace.js";
import { pushService } from "./push-service.js";
import { hardenRuntimeFile } from "./runtime-files.js";

const TICK_MS = 30 * 1000;
const MAX_PER_USER = 100;
const KEEP_DELIVERED = 20;
const MAX_HORIZON_MS = 400 * 24 * 60 * 60 * 1000;

const clean = (value, max) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);

export class ReminderStore {
  constructor(file = path.join(path.resolve(config.dataDir), "reminders.json")) {
    this.file = file;
    this.timer = null;
  }

  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  write(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
    hardenRuntimeFile(this.file, 0o600);
  }

  list(userId, { includeDelivered = false } = {}) {
    const all = this.read()[userId] || [];
    return all
      .filter((item) => includeDelivered || !item.deliveredAt)
      .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  }

  create(userId, input = {}) {
    const title = clean(input.title, 160);
    if (title.length < 2) throw Object.assign(new Error("Reminder text is required"), { status: 400 });
    const dueAt = new Date(input.dueAt);
    if (Number.isNaN(dueAt.getTime())) throw Object.assign(new Error("Reminder time is invalid"), { status: 400 });
    if (dueAt.getTime() > Date.now() + MAX_HORIZON_MS) {
      throw Object.assign(new Error("Reminder is too far in the future"), { status: 400 });
    }
    const all = this.read();
    const own = all[userId] || [];
    if (own.filter((item) => !item.deliveredAt).length >= MAX_PER_USER) {
      throw Object.assign(new Error("Too many pending reminders"), { status: 409 });
    }
    const reminder = {
      id: `rem_${crypto.randomUUID()}`,
      title,
      body: clean(input.body, 600),
      dueAt: dueAt.toISOString(),
      route: clean(input.route, 200) || "#/personal",
      priority: input.priority === "high" ? "high" : "normal",
      createdAt: new Date().toISOString(),
      deliveredAt: "",
    };
    all[userId] = [...own, reminder];
    this.write(all);
    return reminder;
  }

  cancel(userId, reminderId) {
    const all = this.read();
    const own = all[userId] || [];
    const next = own.filter((item) => item.id !== reminderId);
    if (next.length === own.length) return false;
    all[userId] = next;
    this.write(all);
    return true;
  }

  // The account is gone, so nothing here has anyone to remind. Left behind, the
  // undelivered ones keep coming due and drain() keeps trying to push them to a
  // person who no longer has a device — and the titles are the person's own
  // words, which is reason enough on its own.
  removeUser(userId) {
    const all = this.read();
    if (!Object.hasOwn(all, userId)) return 0;
    const count = (all[userId] || []).length;
    delete all[userId];
    this.write(all);
    return count;
  }

  // Delivers everything due, returning what was sent. Safe to call concurrently:
  // a reminder is marked delivered before the inbox write, so a failure drops the
  // notification rather than repeating it every tick.
  async drain(now = Date.now(), deps = {}) {
    const workspaces = deps.memberWorkspaces || memberWorkspaces;
    const push = deps.pushService || pushService;
    const all = this.read();
    const due = [];
    for (const [userId, items] of Object.entries(all)) {
      for (const item of items) {
        if (!item.deliveredAt && new Date(item.dueAt).getTime() <= now) {
          item.deliveredAt = new Date(now).toISOString();
          due.push({ userId, item });
        }
      }
      all[userId] = items
        .filter((item) => !item.deliveredAt)
        .concat(items.filter((item) => item.deliveredAt).slice(-KEEP_DELIVERED));
    }
    if (!due.length) return [];
    this.write(all);

    for (const { userId, item } of due) {
      try {
        const inbox = workspaces.createInboxItem(userId, {
          type: "reminder",
          title: item.title,
          body: item.body,
          priority: item.priority,
          source: "system",
          route: item.route,
        });
        await push.sendInbox(userId, inbox);
      } catch (error) {
        console.error(`[reminders] delivery failed for ${userId}: ${error.message}`);
      }
    }
    return due;
  }

  start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      this.drain().catch((error) => console.error(`[reminders] tick failed: ${error.message}`));
    }, TICK_MS);
    this.timer.unref?.();
    return this.timer;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const reminders = new ReminderStore();
