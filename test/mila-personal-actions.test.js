import assert from "node:assert/strict";
import test from "node:test";

import { createMilaActions, PERSONAL_ACTIONS } from "../server/lib/mila-actions.js";
import { MILA_PERSONAL_TOOLS, MILA_MEMBER_TOOLS, MILA_TOOLS } from "../assets/js/mila-tools.js";

const OWNER = { id: "usr_owner", name: "Бахадыр", role: "Creator" };
const OTHER = { id: "usr_other", name: "Гость", role: "Member" };

function fixture() {
  const created = [];
  const calendarCalls = [];
  const store = new Map();
  let token = 0;

  const memberWorkspaces = {
    listTasks: (userId) => store.get(userId)?.tasks || [],
    createTask: (userId, input) => {
      const task = { id: `tsk_${created.length + 1}`, status: "todo", priority: "normal", dueDate: "", ...input };
      const own = store.get(userId) || { tasks: [], notes: [] };
      own.tasks = [...own.tasks, task];
      store.set(userId, own);
      created.push({ userId, task });
      return task;
    },
    updateTask: (userId, taskId, patch) => {
      const own = store.get(userId);
      const task = own?.tasks.find((item) => item.id === taskId);
      if (!task) return null;
      Object.assign(task, patch);
      return task;
    },
    listNotes: (userId) => store.get(userId)?.notes || [],
    createNote: (userId, input) => {
      const note = { id: "note_1", updatedAt: "2026-08-10T00:00:00.000Z", ...input };
      const own = store.get(userId) || { tasks: [], notes: [] };
      own.notes = [...own.notes, note];
      store.set(userId, own);
      return note;
    },
  };

  const googleWorkspace = {
    status: () => ({ connected: true, canWrite: true }),
    calendarEvents: async (userId, range) => {
      calendarCalls.push({ userId, range });
      return { events: [{ id: "e1", title: "Планёрка", start: "2026-08-10T05:00:00.000Z", end: "2026-08-10T06:00:00.000Z" }] };
    },
    createEvent: async (userId, input) => {
      calendarCalls.push({ userId, input, method: "create" });
      return { event: { id: "e_new", title: input.title, start: input.start } };
    },
    updateEvent: async (userId, eventId, input) => {
      calendarCalls.push({ userId, eventId, input, method: "update" });
      return { event: { id: eventId, title: input.title || "Планёрка", start: input.start } };
    },
    deleteEvent: async (userId, eventId) => {
      calendarCalls.push({ userId, eventId, method: "delete" });
      return { ok: true };
    },
  };

  const reminderCalls = [];
  const reminders = {
    create: (userId, input) => { reminderCalls.push({ userId, input }); return { id: "rem_1", ...input }; },
    list: (userId) => reminderCalls.filter((item) => item.userId === userId).map((item) => ({ id: "rem_1", ...item.input })),
    cancel: (userId, id) => id === "rem_1",
  };

  // Without this the action layer journals into the real Obsidian vault, so a
  // test run would leave "Встреча с закупщиком" in someone's actual notes.
  const journalled = [];
  const journal = { append: async (entry) => { journalled.push(entry); return entry; }, recentText: () => "" };

  return {
    created, calendarCalls, reminderCalls, journalled,
    actions: createMilaActions({
      memberWorkspaces,
      googleWorkspace,
      journal,
      onboarding: { get: () => ({ profile: { timezone: "Asia/Tashkent" } }) },
      reminders,
      dayPlanFor: async (user) => ({
        date: "2026-08-10", timezone: "Asia/Tashkent", summary: `План для ${user.name}`,
        workday: { startLabel: "09:00", endLabel: "18:00" },
        agenda: [], alerts: [], unplaced: [], stats: { load: 12 },
        calendar: { connected: true }, erp: { available: false },
      }),
      makeToken: () => `confirm_${++token}`,
    }),
  };
}

test("MILA's personal desk is scoped to the caller's own account", async () => {
  const { actions, created } = fixture();

  await actions.call("create_my_task", { title: "Позвонить поставщику" }, { actor: OWNER.name, user: OWNER });
  await actions.call("create_my_task", { title: "Чужая задача" }, { actor: OTHER.name, user: OTHER });

  assert.deepEqual(created.map((item) => item.userId), [OWNER.id, OTHER.id]);

  const mine = await actions.call("list_my_tasks", {}, { actor: OWNER.name, user: OWNER });
  assert.equal(mine.count, 1);
  assert.equal(mine.tasks[0].title, "Позвонить поставщику");

  // Without a signed-in user there is no desk to reach — never a shared fallback.
  await assert.rejects(
    actions.call("list_my_tasks", {}, { actor: "Creator" }),
    (error) => error.status === 401,
  );
});

test("capture runs in one step; calendar writes still need confirmation", async () => {
  const { actions, calendarCalls, reminderCalls } = fixture();
  const context = { actor: OWNER.name, user: OWNER };

  // Tasks, notes and reminders are private capture: no token round trip.
  const task = await actions.call("create_my_task", { title: "Собрать отгрузку", priority: "high" }, context);
  assert.equal(task.ok, true);
  assert.equal(task.task.priority, "high");
  const note = await actions.call("save_my_note", { title: "Цена", content: "Оптовая цена — по бага" }, context);
  assert.equal(note.ok, true);
  const reminder = await actions.call("remind_me", { title: "Позвонить в 15:00", dueAt: "2026-08-10T10:00:00.000Z" }, context);
  assert.equal(reminder.ok, true);
  assert.equal(reminderCalls[0].userId, OWNER.id);

  // A calendar event can involve other people, so it stages first and only the
  // matching token executes it.
  const staged = await actions.call("create_calendar_event", {
    title: "Встреча с закупщиком", start: "2026-08-11T05:00:00.000Z",
  }, context);
  assert.equal(staged.confirmationRequired, true);
  assert.equal(calendarCalls.some((call) => call.method === "create"), false);

  const done = await actions.call("create_calendar_event", { confirmationToken: staged.confirmationToken }, context);
  assert.equal(done.event.id, "e_new");
  assert.equal(calendarCalls.find((call) => call.method === "create").userId, OWNER.id);

  // The token is single use.
  await assert.rejects(
    actions.call("create_calendar_event", { confirmationToken: staged.confirmationToken }, context),
    (error) => error.status === 409,
  );
});

test("a confirmation token cannot be spent by a different account", async () => {
  const { actions, calendarCalls } = fixture();
  const staged = await actions.call("cancel_calendar_event", { eventId: "e1" }, { actor: OWNER.name, user: OWNER });

  await assert.rejects(
    actions.call("cancel_calendar_event", { confirmationToken: staged.confirmationToken }, { actor: OTHER.name, user: OTHER }),
    (error) => error.status === 409,
  );
  assert.equal(calendarCalls.some((call) => call.method === "delete"), false);
});

test("the day plan reaches MILA in both readable and speakable form", async () => {
  const { actions } = fixture();
  const result = await actions.call("get_my_day_plan", {}, { actor: OWNER.name, user: OWNER });
  assert.equal(result.plan.date, "2026-08-10");
  assert.match(result.spoken, /План для Бахадыр/);
  assert.match(result.source_policy, /never invent/i);
});

test("ERP work reaches staff only after confirmation, and never from a Member", async () => {
  const erpCalls = [];
  const mcpManager = {
    isLive: () => true,
    connect: async () => ({ tools: [] }),
    getTools: () => [],
    callTool: async (serverId, tool, args) => {
      erpCalls.push({ tool, args });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: { id: 77, tool } }) }] };
    },
  };
  const db = {
    mcp: { list: () => [{ id: "mcp_erp", kind: "erp", name: "milana-erp" }], update: () => {} },
  };
  let token = 0;
  const actions = createMilaActions({
    mcpManager, db, makeToken: () => `confirm_${++token}`,
    journal: { append: async () => null, recentText: () => "" },
    onboarding: { get: () => ({ profile: {} }) },
  });
  const context = { actor: OWNER.name, user: OWNER };

  const staged = await actions.call("send_erp_notification", {
    targetType: "department", department: "Швейный цех", title: "Смена графика", message: "Завтра с 8:00",
  }, context);
  assert.equal(staged.confirmationRequired, true);
  assert.match(staged.summary, /Швейный цех/);
  assert.equal(erpCalls.length, 0, "nothing may reach staff before confirmation");

  await actions.call("send_erp_notification", { confirmationToken: staged.confirmationToken }, context);
  // ERP previews unless its own confirm flag is set, so a missing flag would
  // report a delivery that never happened.
  assert.equal(erpCalls[0].tool, "erp_send_notification");
  assert.equal(erpCalls[0].args.confirm, true);
  assert.equal(erpCalls[0].args.department, "Швейный цех");

  // A task needs a real destination.
  await assert.rejects(
    actions.call("create_erp_task", { title: "Проверить партию" }, context),
    (error) => error.status === 400,
  );

  // Staff-facing ERP work is not part of the personal desk, so the route keeps it
  // behind the operator gate.
  for (const name of ["create_erp_task", "send_erp_notification", "get_erp_late_orders", "list_erp_employee_tasks"]) {
    assert.equal(PERSONAL_ACTIONS.has(name), false, `${name} must stay operator-only`);
    assert.equal(MILA_MEMBER_TOOLS.some((tool) => tool.name === name), false, `${name} must not be offered to a Member`);
  }
});

test("personal tools are declared to the model and offered to Members too", () => {
  const declared = new Set(MILA_PERSONAL_TOOLS.map((tool) => tool.name));
  for (const name of PERSONAL_ACTIONS) {
    assert.equal(declared.has(name), true, `${name} must be declared in MILA_PERSONAL_TOOLS`);
  }
  for (const tool of MILA_PERSONAL_TOOLS) {
    assert.equal(PERSONAL_ACTIONS.has(tool.name), true, `${tool.name} is declared but the server would reject it`);
    assert.equal(MILA_TOOLS.some((item) => item.name === tool.name), true);
    assert.equal(MILA_MEMBER_TOOLS.some((item) => item.name === tool.name), true);
  }
  // Operator surfaces stay out of the Member list.
  for (const name of ["create_kanban_task", "delegate_to_hermes", "ask_claude_code", "call_mcp_tool", "write_obsidian_note"]) {
    assert.equal(MILA_MEMBER_TOOLS.some((tool) => tool.name === name), false, `${name} must not reach a Member`);
  }
});
