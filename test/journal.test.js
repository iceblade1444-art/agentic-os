import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createJournal, JOURNAL_FOLDER } from "../server/lib/journal.js";
import { createMilaActions } from "../server/lib/mila-actions.js";
import { sharedAgentContext, CONTEXT_BUDGET, JOURNAL_CONTEXT_BUDGET } from "../server/lib/onboarding.js";

const TZ = "Asia/Tashkent";
const OWNER = { id: "usr_owner", name: "Бахадыр", role: "Creator" };
// 2026-08-10 14:30 in Tashkent (UTC+5).
const AFTERNOON = new Date("2026-08-10T09:30:00.000Z");

function vault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-journal-"));
  return {
    dir,
    journal: createJournal({ vaultDir: dir, now: () => AFTERNOON }),
    read: (day = "2026-08-10") => {
      try { return fs.readFileSync(path.join(dir, JOURNAL_FOLDER, `${day}.md`), "utf8"); }
      catch { return ""; }
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("entries land in the day file, in the user's timezone", async () => {
  const v = vault();
  await v.journal.append({ actor: "Бахадыр", kind: "task", title: "Задача: Отгрузка", detail: "срок 2026-08-11", timezone: TZ });
  const body = v.read();
  assert.match(body, /^# 2026-08-10$/m);
  assert.match(body, /- 14:30 \*\*Бахадыр\*\* \(task\) Задача: Отгрузка — срок 2026-08-11/);

  // The same instant is still the previous day further west, so the file follows
  // the profile timezone rather than the server's.
  await v.journal.append({ actor: "Бахадыр", title: "Поздняя запись", timezone: "America/New_York" });
  assert.match(v.read("2026-08-10"), /Поздняя запись/);
  v.cleanup();
});

test("a journal line never breaks across lines or grows without bound", async () => {
  const v = vault();
  await v.journal.append({ title: "Строка\nс переносом\r\nи ещё", detail: "  много   пробелов  ", timezone: TZ });
  const line = v.read().split("\n").find((item) => item.startsWith("- "));
  assert.equal(line.includes("\n"), false);
  assert.match(line, /Строка с переносом и ещё — много пробелов/);

  // An entry with nothing to say is not recorded at all.
  assert.equal(await v.journal.append({ detail: "no title", timezone: TZ }), null);

  for (let i = 0; i < 210; i += 1) await v.journal.append({ title: `Запись ${i}`, timezone: TZ });
  const count = (v.read().match(/^- /gm) || []).length;
  assert.ok(count <= 200, `a runaway loop must not grow the file forever, got ${count}`);
  v.cleanup();
});

test("recentText returns the newest days last and respects its budget", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-journal-"));
  fs.mkdirSync(path.join(dir, JOURNAL_FOLDER), { recursive: true });
  for (const [day, text] of [["2026-08-08", "старое"], ["2026-08-09", "вчерашнее"], ["2026-08-10", "сегодняшнее"]]) {
    fs.writeFileSync(path.join(dir, JOURNAL_FOLDER, `${day}.md`), `# ${day}\n\n- 09:00 ${text}\n`);
  }
  const store = createJournal({ vaultDir: dir, now: () => AFTERNOON });

  const all = store.recentText({ days: 3, budget: 2000, timeZone: TZ });
  assert.ok(all.indexOf("старое") < all.indexOf("сегодняшнее"), "newest day must come last");

  // Under pressure the oldest day is what gets dropped.
  const tight = store.recentText({ days: 3, budget: 60, timeZone: TZ });
  assert.equal(tight.includes("старое"), false);
  assert.ok(tight.includes("сегодняшнее"));
  assert.ok(tight.length <= 60);

  assert.deepEqual(store.listDays(), ["2026-08-10", "2026-08-09", "2026-08-08"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing journal is silence, never an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-journal-"));
  const store = createJournal({ vaultDir: path.join(dir, "nope"), now: () => AFTERNOON });
  assert.equal(store.recentText({ timeZone: TZ }), "");
  assert.equal(store.readDay("2026-08-10"), "");
  assert.deepEqual(store.listDays(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

function actionsFixture(journalStore) {
  const store = new Map();
  let token = 0;
  return createMilaActions({
    journal: journalStore,
    onboarding: { get: () => ({ profile: { timezone: TZ } }) },
    memberWorkspaces: {
      listTasks: () => [],
      listNotes: () => [],
      createTask: (userId, input) => ({ id: "tsk_1", status: "todo", priority: "normal", dueDate: "", ...input }),
      updateTask: (userId, id, patch) => ({ id, title: "Отгрузка", ...patch }),
      createNote: (userId, input) => ({ id: "note_1", ...input }),
    },
    reminders: {
      create: (userId, input) => ({ id: "rem_1", ...input }),
      list: () => [],
      cancel: () => true,
    },
    googleWorkspace: {
      status: () => ({ connected: true, canWrite: true }),
      createEvent: async (userId, input) => ({ event: { id: "e_new", title: input.title, start: input.start } }),
    },
    dayPlanFor: async () => ({ date: "2026-08-10", timezone: TZ, summary: "", agenda: [], alerts: [], unplaced: [], stats: {}, workday: {} }),
    makeToken: () => `confirm_${++token}`,
    db: { mcp: { list: () => [], update: () => {} } },
    now: () => AFTERNOON.getTime(),
  });
}

test("MILA records what she did, and only once it really happened", async () => {
  const v = vault();
  const actions = actionsFixture(v.journal);
  const context = { actor: "Бахадыр", user: OWNER };

  await actions.call("create_my_task", { title: "Отгрузка в Казахстан", dueDate: "2026-08-11" }, context);
  await actions.call("remind_me", { title: "Позвонить на фабрику", dueAt: "2026-08-10T10:00:00.000Z" }, context);
  await actions.call("save_my_note", { title: "Цена", content: "по бага" }, context);

  const body = v.read();
  assert.match(body, /Задача: Отгрузка в Казахстан — срок 2026-08-11/);
  assert.match(body, /Напоминание: Позвонить на фабрику/);
  assert.match(body, /Заметка: Цена/);
  assert.match(body, /\*\*Бахадыр\*\*/);

  // Reading the day changes nothing, so it leaves no trace: a journal full of
  // "what's on today" would bury the decisions it exists to keep.
  const before = v.read();
  await actions.call("get_my_day_plan", {}, context);
  await actions.call("list_my_tasks", {}, context);
  assert.equal(v.read(), before);

  // A staged calendar event is not history until it is confirmed.
  const staged = await actions.call("create_calendar_event", { title: "Встреча с закупщиком", start: "2026-08-11T05:00:00.000Z" }, context);
  assert.equal(v.read().includes("Встреча с закупщиком"), false, "staging must not be recorded");
  await actions.call("create_calendar_event", { confirmationToken: staged.confirmationToken }, context);
  assert.match(v.read(), /Встреча: Встреча с закупщиком/);

  v.cleanup();
});

test("the loop closes: what MILA recorded comes back as agent context", () => {
  const owner = { id: "usr_owner", name: "Бахадыр", role: "Creator" };
  const state = {
    workspace: { completedAt: "2026-01-01T00:00:00.000Z", name: "Milana Premium", industry: "Текстиль" },
    profile: { timezone: TZ, locale: "ru-RU" },
  };
  const store = { recentText: ({ budget }) => `2026-08-10:\n- 14:30 Задача: Отгрузка в Казахстан`.slice(0, budget) };

  const context = sharedAgentContext(owner, state, { vault: os.tmpdir(), journal: store });
  assert.match(context, /Milana Premium/, "workspace facts still lead");
  assert.match(context, /day journal, newest last/);
  assert.match(context, /Задача: Отгрузка в Казахстан/);
  assert.ok(context.length <= CONTEXT_BUDGET);

  // The facts come first: when the budget runs out it is the journal that loses
  // its tail, never the authoritative workspace description.
  assert.ok(context.indexOf("Milana Premium") < context.indexOf("day journal"));

  // A Member sees their own profile, but not the operator's journal.
  const member = sharedAgentContext({ id: "u2", name: "Гость", role: "Member" }, state, { vault: os.tmpdir(), journal: store });
  assert.equal(member.includes("day journal"), false);
});

test("a huge journal cannot crowd out the workspace facts", () => {
  const owner = { id: "usr_owner", name: "Бахадыр", role: "Creator" };
  const state = {
    workspace: { completedAt: "2026-01-01T00:00:00.000Z", name: "Milana Premium" },
    profile: { timezone: TZ },
  };
  const flood = { recentText: ({ budget }) => "ж".repeat(Math.max(0, budget)) };
  const context = sharedAgentContext(owner, state, { vault: os.tmpdir(), journal: flood });
  assert.ok(context.length <= CONTEXT_BUDGET, `context must stay within budget, got ${context.length}`);
  assert.match(context, /Milana Premium/);
  // The cap is well under the whole budget so a playbook still has room after it.
  assert.ok((context.match(/ж/g) || []).length <= JOURNAL_CONTEXT_BUDGET);
});

test("an unwritable vault costs the user nothing", async () => {
  const broken = {
    append: async () => { throw new Error("vault is read-only"); },
    recentText: () => "",
  };
  const actions = actionsFixture(broken);
  const result = await actions.call(
    "create_my_task",
    { title: "Всё равно должна создаться" },
    { actor: "Бахадыр", user: OWNER },
  );
  assert.equal(result.ok, true);
  assert.equal(result.task.title, "Всё равно должна создаться");
});
