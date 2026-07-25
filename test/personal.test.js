import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { personalBriefing } from "../server/lib/personal.js";

test("personal briefing prioritizes due work and reports approval pressure", () => {
  const now = new Date("2026-07-25T08:00:00.000Z");
  const result = personalBriefing(
    { name: "Bahodir Karimov" },
    {
      tasks: [
        { id: "later", title: "Later", status: "todo", priority: "high", dueDate: "2026-07-30" },
        { id: "due", title: "Due today", status: "doing", priority: "normal", dueDate: "2026-07-25" },
      ],
    },
    { profile: { timezone: "Asia/Tashkent" } },
    [{ id: "approval_1" }],
    now,
  );

  assert.equal(result.focus.id, "due");
  assert.equal(result.dueCount, 1);
  assert.equal(result.approvalCount, 1);
  assert.equal(result.greetingPeriod, "day");
  assert.equal(result.firstName, "Bahodir");
  assert.match(result.greeting, /Bahodir/);
  assert.match(result.summary, /Due today/);
  assert.ok(result.load > 0);
});

test("personal briefing stays useful with an empty workspace", () => {
  const result = personalBriefing(
    { name: "New Member" },
    { tasks: [] },
    { profile: { timezone: "Invalid/Timezone" } },
    [],
    new Date("2026-07-25T12:00:00.000Z"),
  );

  assert.equal(result.focus, null);
  assert.equal(result.load, 0);
  assert.match(result.summary, /Срочных личных задач нет/);
});

test("Personal is mounted for operator and member shells with a protected API", () => {
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../assets/js/pages/personal.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../server/routes/personal.js", import.meta.url), "utf8");

  assert.match(app, /route: "personal"/);
  assert.match(app, /const MEMBER_PAGES = \{[^}]*personal/);
  assert.match(app, /const OPERATOR_PAGES = \{[\s\S]*personal/);
  assert.match(api, /\/api\/personal/);
  assert.match(server, /app\.use\("\/api\/personal", personal\)/);
  assert.match(route, /memberWorkspaces\.dashboard\(user\.id\)/);
  assert.match(route, /userSoulDocument\(user, state\)/);
  for (const tab of ["today", "soul", "memory", "approvals", "account"]) {
    assert.match(page, new RegExp(`"${tab}"`));
  }
});

