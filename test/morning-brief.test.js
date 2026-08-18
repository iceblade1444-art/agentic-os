import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MorningBrief, briefBody } from "../server/lib/morning-brief.js";
import { OnboardingStore } from "../server/lib/onboarding.js";
import { buildDayPlan } from "../server/lib/personal-planner.js";

const OWNER = { id: "usr_owner", name: "Бахадыр", role: "Creator" };
const TZ = "Asia/Tashkent";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-brief-"));
  const inbox = [];
  const pushed = [];
  return {
    dir,
    inbox,
    pushed,
    brief: new MorningBrief(path.join(dir, "morning-brief.json")),
    deps: (profile = { timezone: TZ, briefTime: "08:00", completedAt: "2026-01-01T00:00:00.000Z" }) => ({
      users: { list: () => [] },
      creatorUser: () => OWNER,
      // Without this stub the real companyBrief spawns the real ERP MCP child;
      // on machines where that python actually starts (the docker image, CI)
      // the leaked process kept node --test alive for the full 6-hour cap.
      companyBrief: { blocks: async () => "" },
      onboarding: { get: () => ({ profile }) },
      memberWorkspaces: {
        createInboxItem: (userId, item) => { inbox.push({ userId, item }); return { id: `inb_${inbox.length}`, ...item }; },
      },
      pushService: { sendInbox: async (userId, item) => { pushed.push({ userId, item }); return { delivered: 1 }; } },
      dayPlanFor: async (user, options) => buildDayPlan({
        user,
        profile: { timezone: TZ },
        now: options.now,
        tasks: [{ id: "t1", title: "Согласовать отгрузку", status: "todo", priority: "high", dueDate: "2026-08-01" }],
        events: [{ id: "e1", title: "Планёрка", start: "2026-08-10T05:00:00.000Z", end: "2026-08-10T06:00:00.000Z" }],
      }),
    }),
  };
}

test("the brief fires once per local morning and not again that day", async () => {
  const { brief, deps, inbox, pushed, dir } = fixture();
  const config = deps();

  // 06:30 local — before the 08:00 slot.
  assert.deepEqual(await brief.run(new Date("2026-08-10T01:30:00.000Z"), config), []);
  assert.equal(inbox.length, 0);

  // 08:10 local.
  assert.deepEqual(await brief.run(new Date("2026-08-10T03:10:00.000Z"), config), [OWNER.id]);
  assert.equal(inbox.length, 1);
  assert.equal(pushed.length, 1);
  assert.equal(inbox[0].item.type, "reminder");
  assert.match(inbox[0].item.title, /2026-08-10/);
  // An overdue task makes it worth waking the phone for.
  assert.equal(inbox[0].item.priority, "high");

  // Every later tick the same day is a no-op.
  assert.deepEqual(await brief.run(new Date("2026-08-10T04:10:00.000Z"), config), []);
  assert.equal(inbox.length, 1);

  // Next morning it fires again.
  assert.deepEqual(await brief.run(new Date("2026-08-11T03:10:00.000Z"), config), [OWNER.id]);
  assert.equal(inbox.length, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("the brief gives ERP room the interactive page cannot", async () => {
  const { brief, deps, dir } = fixture();
  const config = deps();
  const budgets = [];
  config.dayPlanFor = async (user, options) => {
    budgets.push(options.erpTimeoutMs);
    return buildDayPlan({ user, profile: { timezone: TZ }, now: options.now });
  };

  await brief.run(new Date("2026-08-10T03:10:00.000Z"), config);
  // The first ERP read of the day pays for a cold connect and a login; a page
  // load can refresh later, an unattended brief cannot.
  assert.equal(budgets.length, 1);
  assert.ok(budgets[0] >= 15000, `expected a generous ERP budget, got ${budgets[0]}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a brief that missed its window by hours is skipped rather than sent late", async () => {
  const { brief, deps, inbox, dir } = fixture();
  // 14:00 local, six hours past the 08:00 slot.
  assert.deepEqual(await brief.run(new Date("2026-08-10T09:00:00.000Z"), deps()), []);
  assert.equal(inbox.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the brief respects the switch and an unfinished profile", async () => {
  const { brief, deps, inbox, dir } = fixture();
  const morning = new Date("2026-08-10T03:10:00.000Z");

  await brief.run(morning, deps({ timezone: TZ, briefTime: "08:00", briefEnabled: false, completedAt: "2026-01-01" }));
  assert.equal(inbox.length, 0);

  // No completed profile means no known timezone, so nothing is guessed.
  await brief.run(morning, deps({ timezone: TZ, briefTime: "08:00" }));
  assert.equal(inbox.length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("brief text is speakable and push-sized: no markdown, real times", async () => {
  const plan = buildDayPlan({
    profile: { timezone: TZ },
    now: new Date("2026-08-10T03:00:00.000Z"),
    events: [{ id: "e1", title: "Планёрка", start: "2026-08-10T05:00:00.000Z", end: "2026-08-10T06:00:00.000Z" }],
    erp: { available: true, lateOrders: 2 },
  });
  const body = briefBody(plan);
  assert.match(body, /10:00 — Планёрка/);
  assert.match(body, /⚠ Просроченных заказов: 2/);
  assert.doesNotMatch(body, /[#*`]|https?:\/\//);
});

test("working hours are validated and an inverted day falls back to the default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-onboarding-"));
  const store = new OnboardingStore(path.join(dir, "onboarding.json"));
  // A Member so the update touches the profile only: workspace validation is a
  // separate concern already covered elsewhere.
  const user = { id: "usr_1", name: "Owner", role: "Member" };

  const saved = store.update(user, { profile: { workdayStart: "7:30", workdayEnd: "16:00", lunchStart: "12:00", lunchEnd: "12:45", briefTime: "06:15" } });
  assert.equal(saved.profile.workdayStart, "07:30");
  assert.equal(saved.profile.workdayEnd, "16:00");
  assert.equal(saved.profile.lunchStart, "12:00");
  assert.equal(saved.profile.briefTime, "06:15");
  assert.equal(saved.profile.briefEnabled, true);

  // An end before the start would leave the planner with no day at all.
  const inverted = store.update(user, { profile: { workdayStart: "18:00", workdayEnd: "09:00" } });
  assert.equal(inverted.profile.workdayStart, "09:00");
  assert.equal(inverted.profile.workdayEnd, "18:00");

  // Malformed input keeps whatever was already saved instead of resetting the
  // user's schedule to the factory default.
  const garbage = store.update(user, { profile: { workdayStart: "99:99", briefTime: "not a time" } });
  assert.equal(garbage.profile.workdayStart, "09:00");
  assert.equal(garbage.profile.briefTime, "06:15");

  // The plan actually honours the saved hours.
  const custom = store.update(user, { profile: { workdayStart: "07:00", workdayEnd: "12:00" } });
  const plan = buildDayPlan({
    profile: { ...custom.profile, timezone: TZ },
    now: new Date("2026-08-09T22:00:00.000Z"),
    tasks: [{ id: "t1", title: "Ранняя задача", status: "todo", priority: "normal", dueDate: "" }],
  });
  assert.equal(plan.workday.startLabel, "07:00");
  assert.equal(plan.workday.endLabel, "12:00");
  assert.equal(plan.agenda[0].start, "2026-08-10T02:00:00.000Z");

  fs.rmSync(dir, { recursive: true, force: true });
});
