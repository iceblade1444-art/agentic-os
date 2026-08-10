import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDayPlan, spokenPlan, planningInternals } from "../server/lib/personal-planner.js";
import { ReminderStore } from "../server/lib/reminders.js";

const TZ = "Asia/Tashkent";
// 2026-08-10 08:00 in Tashkent (UTC+5).
const MORNING = new Date("2026-08-10T03:00:00.000Z");

const task = (over = {}) => ({
  id: `tsk_${over.title || Math.random()}`,
  title: "Task",
  detail: "",
  status: "todo",
  priority: "normal",
  dueDate: "",
  createdAt: MORNING.toISOString(),
  updatedAt: MORNING.toISOString(),
  ...over,
});

test("wall-clock times resolve inside the user's zone, not the server's", () => {
  const nine = planningInternals.instantFromLocal(TZ, { year: 2026, month: 8, day: 10, hour: 9, minute: 0 });
  assert.equal(nine.toISOString(), "2026-08-10T04:00:00.000Z");
  assert.equal(planningInternals.localDateKey(MORNING, TZ), "2026-08-10");
  // The same instant is still the previous day in a western zone: the plan must
  // follow the profile timezone rather than UTC.
  assert.equal(planningInternals.localDateKey(new Date("2026-08-10T02:00:00.000Z"), "America/New_York"), "2026-08-09");
});

test("focus blocks land in the gaps between meetings and never before now", () => {
  const plan = buildDayPlan({
    user: { name: "Бахадыр Мирзаев" },
    profile: { timezone: TZ },
    now: MORNING,
    events: [
      { id: "e1", title: "Планёрка", start: "2026-08-10T05:00:00.000Z", end: "2026-08-10T06:00:00.000Z" },
    ],
    tasks: [task({ id: "t1", title: "Срочное", priority: "high", dueDate: "2026-08-10" })],
  });

  const focus = plan.agenda.filter((item) => item.kind === "focus");
  assert.equal(focus.length, 1);
  assert.equal(focus[0].taskId, "t1");
  // It is 08:00 and the workday starts at 09:00, so focus work waits for the
  // workday and still ends before the 10:00 meeting.
  assert.equal(focus[0].start, "2026-08-10T04:00:00.000Z");
  assert.ok(new Date(focus[0].end) <= new Date("2026-08-10T05:00:00.000Z"));
  assert.equal(plan.agenda[0].kind, "focus");
  assert.equal(plan.agenda[1].kind, "event");
  assert.equal(plan.firstName, "Бахадыр");
});

test("a plan built mid-day starts from now, not from a slot that already passed", () => {
  const plan = buildDayPlan({
    profile: { timezone: TZ },
    // 14:20 local.
    now: new Date("2026-08-10T09:20:00.000Z"),
    tasks: [task({ id: "t1", title: "Досдать отчёт" })],
  });
  const focus = plan.agenda.find((item) => item.kind === "focus");
  assert.equal(focus.start, "2026-08-10T09:20:00.000Z");
});

test("overdue work, clashing meetings and pending approvals surface as alerts", () => {
  const plan = buildDayPlan({
    profile: { timezone: TZ },
    now: MORNING,
    tasks: [task({ id: "old", title: "Забытая", dueDate: "2026-08-01" })],
    events: [
      { id: "a", title: "Звонок с фабрикой", start: "2026-08-10T06:00:00.000Z", end: "2026-08-10T07:00:00.000Z" },
      { id: "b", title: "Приёмка ткани", start: "2026-08-10T06:30:00.000Z", end: "2026-08-10T07:30:00.000Z" },
    ],
    approvals: [{ id: "ap1", title: "Hermes хочет опубликовать пост" }],
  });

  const ids = plan.alerts.map((alert) => alert.id);
  assert.ok(ids.includes("overdue_old"));
  assert.ok(ids.some((id) => id.startsWith("conflict_")));
  assert.ok(ids.includes("approvals"));
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.stats.overdue, 1);
});

test("ERP flags reach the plan, and a missing ERP contributes nothing", () => {
  const withErp = buildDayPlan({
    profile: { timezone: TZ }, now: MORNING,
    erp: { available: true, lateOrders: 3, lateOrdersDetail: "№1201, №1204" },
  });
  const late = withErp.alerts.find((alert) => alert.id === "erp_late_orders");
  assert.equal(late.level, "high");
  assert.match(late.title, /3/);

  const withoutErp = buildDayPlan({ profile: { timezone: TZ }, now: MORNING, erp: { available: false } });
  assert.equal(withoutErp.alerts.some((alert) => alert.source === "erp"), false);
});

test("tasks that do not fit the day are reported instead of silently dropped", () => {
  const plan = buildDayPlan({
    profile: { timezone: TZ },
    now: MORNING,
    tasks: Array.from({ length: 9 }, (_, index) => task({ id: `t${index}`, title: `Задача ${index}` })),
  });
  assert.equal(plan.stats.focusBlocks <= 5, true);
  assert.ok(plan.unplaced.length > 0);
  assert.ok(plan.alerts.some((alert) => alert.id.startsWith("unplaced_")));
});

test("the spoken plan is speakable: no markdown, no paths, real times", () => {
  const plan = buildDayPlan({
    profile: { timezone: TZ }, now: MORNING,
    events: [{ id: "e1", title: "Планёрка", start: "2026-08-10T05:00:00.000Z", end: "2026-08-10T06:00:00.000Z" }],
  });
  const spoken = spokenPlan(plan);
  assert.match(spoken, /10:00–11:00 — встреча: Планёрка/);
  assert.doesNotMatch(spoken, /[#*`]|https?:\/\//);
});

test("reminders fire once into the inbox and push, then stop being pending", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-reminders-"));
  const store = new ReminderStore(path.join(dir, "reminders.json"));
  const inbox = [];
  const pushed = [];
  const deps = {
    memberWorkspaces: { createInboxItem: (userId, item) => { inbox.push({ userId, item }); return { id: "inb_1", ...item }; } },
    pushService: { sendInbox: async (userId, item) => { pushed.push({ userId, item }); return { delivered: 1 }; } },
  };

  const due = store.create("user_1", { title: "Позвонить в Ташкент", dueAt: "2026-08-10T10:00:00.000Z" });
  store.create("user_1", { title: "Позже", dueAt: "2026-08-11T10:00:00.000Z" });
  assert.equal(store.list("user_1").length, 2);

  const fired = await store.drain(new Date("2026-08-10T10:00:01.000Z").getTime(), deps);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].item.id, due.id);
  assert.equal(inbox[0].item.type, "reminder");
  assert.equal(pushed.length, 1);

  // A second drain at the same moment must not deliver it again.
  const again = await store.drain(new Date("2026-08-10T10:00:02.000Z").getTime(), deps);
  assert.equal(again.length, 0);
  assert.equal(store.list("user_1").length, 1);

  assert.throws(() => store.create("user_1", { title: "Проверка", dueAt: "not a date" }), /invalid/i);
  assert.throws(() => store.create("user_1", { title: "", dueAt: "2026-08-11T10:00:00.000Z" }), /required/i);
  assert.equal(store.cancel("user_1", "rem_missing"), false);

  fs.rmSync(dir, { recursive: true, force: true });
});
