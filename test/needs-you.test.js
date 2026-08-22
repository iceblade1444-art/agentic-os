// What is waiting on a person, and — more importantly — whose.
//
// The queue composes four subsystems, two of which are operator-only. That
// makes it exactly the shape of thing this codebase has leaked through before:
// a surface that assembles context from several stores and forgets which of
// them belong to the asker. So most of what is asserted here is not "does the
// list contain the right items" but "does a Member's list contain only theirs".

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemberWorkspaceStore } from "../server/lib/member-workspace.js";
import {
  awaitingDecision, blockedHard, needsYou, overdueTasks, urgentUnread, waitingOnAnswer,
} from "../server/lib/needs-you.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };
const MEMBER = { id: "usr_2", name: "Шавкат", role: "Member" };
const TODAY = "2026-08-22";

const board = {
  columns: [{
    name: "blocked",
    tasks: [
      { id: "t1", title: "Прайс для Казахстана", status: "blocked", block_kind: "needs_input",
        block_reason: "Оптовая цена или розничная?", updated_at: "2026-08-22T07:03:00Z" },
      { id: "t2", title: "Выгрузка в 1С", status: "blocked", block_kind: "error",
        block_reason: "ERP timeout", updated_at: "2026-08-22T05:00:00Z" },
      { id: "t3", title: "Идёт", status: "running" },
    ],
  }],
};
const approvals = [
  { id: "ap1", action: "publish", summary: "Опубликовать лукбук", project: "design", requestedAt: "2026-08-22T08:30:00Z" },
];

function workspace() {
  const store = new MemberWorkspaceStore(fs.mkdtempSync(path.join(os.tmpdir(), "aos-ny-")));
  return store;
}

/* ---------------- the pieces ---------------- */

test("an agent that asked a question is separated from one that crashed", () => {
  // They need different things from a person: one needs an answer typed, the
  // other needs somebody to go and look. Collapsing them into "blocked" is why
  // the waiting ones sat for hours.
  assert.deepEqual(waitingOnAnswer(board).map((i) => i.title), ["Прайс для Казахстана"]);
  assert.deepEqual(blockedHard(board).map((i) => i.title), ["Выгрузка в 1С"]);
  assert.equal(waitingOnAnswer(board)[0].detail, "Оптовая цена или розничная?");
  // A bridge that is down returns null, not an empty board; the difference
  // matters because one means "nothing waiting" and the other means "unknown".
  assert.deepEqual(waitingOnAnswer(null), []);
  assert.deepEqual(blockedHard(undefined), []);
});

test("only tasks actually past their date count as overdue", () => {
  const tasks = [
    { id: "a", title: "Вчерашняя", status: "todo", dueDate: "2026-08-21" },
    { id: "b", title: "Сегодняшняя", status: "todo", dueDate: TODAY },
    { id: "c", title: "Сделанная", status: "done", dueDate: "2026-08-01" },
    { id: "d", title: "Без срока", status: "todo", dueDate: "" },
  ];
  assert.deepEqual(overdueTasks(tasks, TODAY).map((i) => i.title), ["Вчерашняя"]);
});

test("urgent means somebody marked it urgent, not that it is unread", () => {
  const inbox = [
    { id: "1", title: "Срочное", status: "unread", priority: "high", createdAt: "2026-08-22T06:00:00Z" },
    { id: "2", title: "Обычное", status: "unread", priority: "normal", createdAt: "2026-08-22T06:00:00Z" },
    { id: "3", title: "Прочитанное", status: "read", priority: "high", createdAt: "2026-08-22T06:00:00Z" },
  ];
  assert.deepEqual(urgentUnread(inbox).map((i) => i.title), ["Срочное"]);
});

test("an approval carries what is being decided, not just that one exists", () => {
  const [item] = awaitingDecision(approvals);
  assert.equal(item.title, "Опубликовать лукбук");
  assert.equal(item.kind, "approval");
  assert.equal(item.route, "missions");
});

/* ---------------- composition and order ---------------- */

test("worst first, and oldest first within that", async () => {
  const workspaces = workspace();
  workspaces.createInboxItem(OWNER.id, { title: "Срочное", priority: "high", createdAt: "2026-08-22T09:00:00Z" });
  const result = await needsYou(OWNER, {
    workspaces, today: TODAY,
    board: () => board,
    approvals: () => approvals,
  });

  assert.deepEqual(result.items.map((i) => i.severity),
    ["blocked", "waiting", "waiting", "attention"]);
  // Inside "waiting", the 07:03 task comes before the 08:30 approval: the thing
  // that has been waiting longest is the one most likely to be forgotten.
  const waiting = result.items.filter((i) => i.severity === "waiting");
  assert.deepEqual(waiting.map((i) => i.kind), ["waiting", "approval"]);
  assert.equal(result.severity, "blocked", "the badge takes its colour from the worst present");
  assert.equal(result.total, 4);
  assert.deepEqual(result.counts, { blocked: 1, waiting: 1, approval: 1, inbox: 1 });
});

test("an empty queue says so rather than looking broken", async () => {
  const result = await needsYou(OWNER, {
    workspaces: workspace(), today: TODAY,
    board: () => ({ columns: [] }),
    approvals: () => [],
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.total, 0);
  assert.equal(result.severity, "");
});

/* ---------------- whose queue it is ---------------- */

test("a Member's queue contains only what is theirs", async () => {
  // The fleet's blocked tasks and the approval queue are the company's, not a
  // floor manager's. Gating here rather than in the route means a new caller
  // cannot accidentally be handed them.
  const workspaces = workspace();
  workspaces.createTask(MEMBER.id, { title: "Просроченная", dueDate: "2026-08-20" });
  let boardAsked = false;
  let approvalsAsked = false;

  const result = await needsYou(MEMBER, {
    workspaces, today: TODAY,
    board: () => { boardAsked = true; return board; },
    approvals: () => { approvalsAsked = true; return approvals; },
  });

  assert.deepEqual(result.items.map((i) => i.kind), ["overdue"]);
  assert.equal(result.items[0].title, "Просроченная");
  // Not merely filtered out afterwards — never fetched. The only reliable way
  // not to say something in a room is not to know it there.
  assert.equal(boardAsked, false, "a Member's request must not even ask for the fleet board");
  assert.equal(approvalsAsked, false, "nor for the approval queue");
});

test("Design is not an operator here either", async () => {
  let boardAsked = false;
  const result = await needsYou({ id: "usr_3", role: "Design" }, {
    workspaces: workspace(), today: TODAY,
    board: () => { boardAsked = true; return board; },
    approvals: () => approvals,
  });
  assert.equal(boardAsked, false);
  assert.deepEqual(result.items, []);
});

test("one person's queue never contains another person's tasks", async () => {
  const workspaces = workspace();
  workspaces.createTask(OWNER.id, { title: "Дело владельца", dueDate: "2026-08-01" });
  workspaces.createTask(MEMBER.id, { title: "Дело сотрудника", dueDate: "2026-08-01" });

  const mine = await needsYou(MEMBER, { workspaces, today: TODAY });
  assert.deepEqual(mine.items.map((i) => i.title), ["Дело сотрудника"]);
});

/* ---------------- degrading ---------------- */

test("a down bridge costs the fleet items, never the whole queue", async () => {
  // The queue is the first thing on every screen. If Hermes being unreachable
  // emptied it, the screen would say "nothing needs you" at the exact moment
  // something did.
  const workspaces = workspace();
  workspaces.createTask(OWNER.id, { title: "Просроченная", dueDate: "2026-08-01" });

  const result = await needsYou(OWNER, {
    workspaces, today: TODAY,
    board: () => Promise.reject(new Error("bridge down")),
    approvals: () => Promise.reject(new Error("runtime down")),
  });
  assert.deepEqual(result.items.map((i) => i.kind), ["overdue"]);
});

test("a broken personal store costs its own items, never the fleet's", async () => {
  const result = await needsYou(OWNER, {
    workspaces: {
      listTasks: () => { throw new Error("disk gone"); },
      listInbox: () => [],
    },
    today: TODAY,
    board: () => board,
    approvals: () => [],
  });
  assert.deepEqual(result.items.map((i) => i.kind), ["blocked", "waiting"]);
});

test("the route is mounted for everyone, and gates by role inside", () => {
  const index = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  assert.match(index, /app\.use\("\/api\/needs-you", needsYouRoute\)/);
  // Not behind requireOperator: a Member has a queue too. The gate is the role
  // check inside needsYou(), which is tested above.
  assert.doesNotMatch(index, /app\.use\("\/api\/needs-you", requireOperator/);
  const route = fs.readFileSync(new URL("../server/routes/needs-you.js", import.meta.url), "utf8");
  assert.match(route, /authenticatedUser\(req\)/);
  assert.match(route, /status\(401\)/, "an unauthenticated caller gets nothing");
});
