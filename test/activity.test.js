// The feed the phone opens on, and the two things that would make it a
// liability: one person's entries reaching another, and a deleted account
// leaving its history behind.
//
// The day journal was the obvious store and could not be used — one file a day
// for the whole company. This one is per-user and records only what had already
// been delivered to that same person, so the test that matters most is the
// isolation one.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ActivityStore, entryFromItem, publicEntry } from "../server/lib/activity.js";
import { cardKindOf } from "../server/lib/telegram-cards.js";

const tmp = () => path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "aos-activity-")), "activity.json",
);

test("a feed is readable only by the person it belongs to", () => {
  const store = new ActivityStore(tmp());
  store.append("creator", { kind: "task", title: "Партия 214 — замер" });
  store.append("shuhrat", { kind: "reminder", title: "Позвонить поставщику" });

  const mine = store.list("creator");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].title, "Партия 214 — замер");
  // The other person's row is not merely ordered lower; it is absent.
  assert.equal(mine.some((e) => e.title.includes("поставщику")), false);
  assert.equal(store.list("shuhrat").length, 1);
});

test("there is no way to ask for a feed without saying whose", () => {
  const store = new ActivityStore(tmp());
  store.append("creator", { kind: "task", title: "Что-то" });
  for (const missing of ["", null, undefined, "   "]) {
    assert.deepEqual(store.list(missing), [], `list(${JSON.stringify(missing)}) returned rows`);
    assert.equal(store.append(missing, { title: "x" }), null);
  }
});

test("deleting an account takes its feed with it", () => {
  const file = tmp();
  const store = new ActivityStore(file);
  store.append("gone", { kind: "task", title: "Задача" });
  store.append("stays", { kind: "task", title: "Другая" });

  assert.equal(store.removeUser("gone"), 1);
  assert.deepEqual(store.list("gone"), []);
  assert.equal(store.list("stays").length, 1, "and only that account's");

  // On disk too, or the next process reads it back.
  const reopened = new ActivityStore(file);
  assert.deepEqual(reopened.list("gone"), []);
  assert.equal(reopened.list("stays").length, 1);
});

test("account-lifecycle actually calls it", async () => {
  // A store with removeUser that nobody calls is the same as no store at all.
  const source = fs.readFileSync(new URL("../server/lib/account-lifecycle.js", import.meta.url), "utf8");
  assert.match(source, /activityStore\.removeUser\(id\)/);
  assert.match(source, /dependencies\.activity \|\| activity/,
    "injectable, like every other store in this file");
});

test("one busy account cannot evict another's history", () => {
  const store = new ActivityStore(tmp());
  store.append("quiet", { kind: "task", title: "Единственная запись" });
  for (let i = 0; i < 200; i++) {
    store.append("loud", { kind: "message", title: `Сообщение ${i}` });
  }
  assert.equal(store.list("quiet").length, 1, "the quiet account still has its row");
  assert.ok(store.list("loud", { limit: 500 }).length <= 120, "and the loud one is capped");
});

test("newest first, because the feed is read from the top", () => {
  const store = new ActivityStore(tmp());
  store.append("u", { kind: "task", title: "старое", at: "2026-08-20T08:00:00.000Z" });
  store.append("u", { kind: "task", title: "новое", at: "2026-08-22T08:00:00.000Z" });
  store.append("u", { kind: "task", title: "среднее", at: "2026-08-21T08:00:00.000Z" });
  assert.deepEqual(store.list("u").map((e) => e.title), ["новое", "среднее", "старое"]);
});

test("an entry with nothing to read is not recorded", () => {
  const store = new ActivityStore(tmp());
  assert.equal(store.append("u", { kind: "system" }), null);
  assert.equal(store.append("u", { kind: "system", title: "   " }), null);
  assert.deepEqual(store.list("u"), []);
});

test("a delivered notification becomes a row without inventing anything", () => {
  // Titles come from the item that was already on its way to this person, so
  // the feed cannot widen what they can see.
  const item = { type: "reminder", title: "Позвонить Ортикову", body: "15:00, цех 2" };
  const entry = entryFromItem("creator", item, cardKindOf);
  assert.equal(entry.userId, "creator");
  assert.equal(entry.kind, "reminder");
  assert.equal(entry.title, "Позвонить Ортикову");
  assert.equal(entry.detail, "15:00, цех 2");

  // The morning brief identifies itself by speak, not by a type field — the
  // same rule the Telegram cards use, so the two surfaces cannot disagree.
  assert.equal(entryFromItem("creator", { speak: true, title: "Сводка" }, cardKindOf).kind, "brief");
  // And an unknown kind lands somewhere real rather than throwing.
  assert.equal(entryFromItem("creator", { type: "wat", title: "x" }, cardKindOf).kind, "system");
});

test("a row carries a route, never a payload", () => {
  // A feed that stores content goes stale and then lies. It stores where to
  // look, and the phone asks for the thing itself.
  const entry = publicEntry({ userId: "u", kind: "task", title: "t", route: "/tasks/9" });
  assert.equal(entry.route, "/tasks/9");
  assert.equal(Object.hasOwn(entry, "payload"), false);
  assert.deepEqual(
    Object.keys(entry).sort(),
    ["at", "detail", "id", "kind", "route", "title", "userId"],
  );
});

test("every notification passes the recorder, and cannot be broken by it", () => {
  const source = fs.readFileSync(new URL("../server/lib/push-service.js", import.meta.url), "utf8");
  // sendInbox is the single door: reminders, briefs, calendar, messenger, ERP.
  // Recording there is what makes the feed complete without a second hook.
  assert.match(source, /activity\.append\(userId, entryFromItem\(userId, item, cardKindOf\)\)/);
  // And it is wrapped, because a feed is worth less than a delivered reminder.
  const body = source.slice(source.indexOf("async sendInbox"));
  const hook = body.indexOf("activity.append");
  const guard = body.lastIndexOf("try {", hook);
  assert.ok(guard !== -1 && guard < hook, "the append must sit inside a try");
});
