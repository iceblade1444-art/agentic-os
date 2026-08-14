// The evening close: what was done, what stayed open, what tomorrow starts with.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEveningSummary } from "../server/lib/evening-summary.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };
// 2026-08-14, 18:35 Tashkent = 13:35 UTC. Workday ends 18:00.
const EVENING = new Date("2026-08-14T13:35:00.000Z");

function fixture({ tasks = [], events = [], remindersDue = [], when = EVENING } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-evening-"));
  const inbox = [];
  const instance = createEveningSummary({
    file: path.join(dir, "state.json"),
    memberWorkspaces: { listTasks: () => tasks },
    reminders: { list: () => remindersDue },
    googleWorkspace: {
      status: () => ({ connected: events.length > 0 }),
      calendarEvents: async () => ({ events }),
    },
    pushService: { sendInbox: async (userId, item) => { inbox.push({ userId, item }); return {}; } },
    onboarding: { get: () => ({ profile: { completedAt: "2026-01-01", timezone: "Asia/Tashkent", workdayEnd: "18:00" } }) },
    users: { list: () => [] },
    creatorUser: () => OWNER,
  });
  return { instance, inbox, when, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("done today, open, and tomorrow's first meeting — nothing invented", async () => {
  const f = fixture({
    tasks: [
      { title: "Отгрузка в Казахстан", status: "done", updatedAt: "2026-08-14T09:00:00.000Z" },
      { title: "Старое дело", status: "done", updatedAt: "2026-08-10T09:00:00.000Z" },
      { title: "Сертификаты", status: "todo", priority: "high" },
    ],
    events: [{ title: "Планёрка с цехом", start: "2026-08-15T04:00:00.000Z" }],
    remindersDue: [{ title: "Позвонить", dueAt: "2026-08-15T05:00:00.000Z" }],
  });
  const sent = await f.instance.run(f.when);
  assert.deepEqual(sent, [OWNER.id]);
  const body = f.inbox[0].item.body;
  assert.match(body, /Закрыто сегодня: 1 — Отгрузка в Казахстан/);
  assert.equal(body.includes("Старое дело"), false, "a task closed days ago is not today's win");
  assert.match(body, /Открыто: 1 \(есть срочные\)/);
  assert.match(body, /Завтра первым: Планёрка с цехом/);
  assert.match(body, /Напоминаний на завтра: 1/);
  f.cleanup();
});

test("once per evening, not at midnight, and an empty day is said plainly", async () => {
  const f = fixture({ tasks: [] });
  await f.instance.run(f.when);
  assert.equal((await f.instance.run(f.when)).length, 0, "second tick the same evening sends nothing");
  assert.match(f.inbox[0].item.body, /ни одна задача не закрыта/);

  const midnight = fixture({ when: new Date("2026-08-14T19:30:00.000Z") }); // 00:30 local
  assert.equal((await midnight.instance.run(midnight.when)).length, 0, "a missed slot is skipped, not delivered at night");
  midnight.cleanup();
  f.cleanup();
});

test("a broken calendar loses the calendar line, never the summary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-evening-"));
  const inbox = [];
  const instance = createEveningSummary({
    file: path.join(dir, "state.json"),
    memberWorkspaces: { listTasks: () => [] },
    reminders: { list: () => [] },
    googleWorkspace: { status: () => ({ connected: true }), calendarEvents: async () => { throw new Error("google down"); } },
    pushService: { sendInbox: async (userId, item) => { inbox.push({ userId, item }); return {}; } },
    onboarding: { get: () => ({ profile: { completedAt: "2026-01-01", timezone: "Asia/Tashkent", workdayEnd: "18:00" } }) },
    users: { list: () => [] },
    creatorUser: () => OWNER,
  });
  const sent = await instance.run(EVENING);
  assert.equal(sent.length, 1);
  assert.equal(inbox[0].item.body.includes("Завтра первым"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
