// A notification in Telegram is an object with verbs, not a paragraph.
//
// Every notification used to arrive as the same unformatted blob with one
// button — "Озвучить" — so a reminder could be heard and not completed, a
// colleague's message could be heard and not opened, and an ERP anomaly could
// be heard and not acknowledged. For most of the people this product serves,
// Telegram is the whole product.
//
// The composition half is pure and tested as functions; the delivery half is
// driven through the real bridge with a fake fetch, because "which chat did it
// leave for" is the invariant that matters most here and it only exists at that
// level.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemberWorkspaceStore } from "../server/lib/member-workspace.js";
import { TelegramBridge } from "../server/lib/telegram.js";
import {
  buildCard, cardKindOf, CALLBACK_LIMIT, commandList, encodeCallback, escapeHtml, parseCallback,
} from "../server/lib/telegram-cards.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };
const CHAT = 777;

function harness({ locale = "ru-RU", timezone = "Asia/Tashkent" } = {}) {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-tgc-"));
  const workspaces = new MemberWorkspaceStore(fs.mkdtempSync(path.join(os.tmpdir(), "aos-tgw-")));
  const created = [];
  const instance = new TelegramBridge({
    file: path.join(dir, "links.json"),
    integrations: () => ({ botToken: "test-token" }),
    workspaces,
    users: { get: () => OWNER },
    creatorUser: () => OWNER,
    onboarding: { get: () => ({ profile: { locale, timezone } }) },
    reminders: { create: (userId, input) => { created.push({ userId, ...input }); return input; } },
    speaker: { speak: async () => Buffer.from([1, 2, 3]) },
    publicUrl: () => "https://agent.milanapremium.uz",
    fetch: async (url, options) => {
      const method = url.split("/").pop();
      // Text goes as JSON, audio as multipart: the stub has to survive both.
      const raw = options?.body;
      const body = raw instanceof FormData
        ? Object.fromEntries([...raw.keys()].map((key) => [key, raw.get(key)]))
        : JSON.parse(raw || "{}");
      calls.push({ method, body });
      const result = method === "getMe" ? { username: "milana_mila_bot" } : { message_id: 42 };
      return { ok: true, json: async () => ({ ok: true, result }) };
    },
  });
  const link = async () => {
    const { url } = await instance.issueLinkCode(OWNER);
    await instance.handleUpdateForTest({
      message: { chat: { id: CHAT }, from: {}, text: `/start ${url.split("start=")[1]}` },
    });
    calls.length = 0;
  };
  return {
    instance, calls, workspaces, created, link,
    sent: () => calls.filter((c) => c.method === "sendMessage"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/* ---------------- composition ---------------- */

test("a title with markup in it does not destroy the message", () => {
  // Telegram rejects a malformed HTML body outright, so an unescaped "<" in a
  // task title does not render oddly — the notification is simply never sent.
  assert.equal(escapeHtml('<Ташкент> & Co'), "&lt;Ташкент&gt; &amp; Co");
  const card = buildCard({ type: "task", id: "inb_1", title: "<b>Отгрузка</b> & Co" });
  assert.match(card.text, /&lt;b&gt;Отгрузка&lt;\/b&gt; &amp; Co/);
  assert.equal(card.parseMode, "HTML");
});

test("each kind of thing offers the verbs that kind supports", () => {
  const verbs = (item) => buildCard(item, { publicUrl: "https://x.test" })
    .keyboard.inline_keyboard.flat().map((b) => b.text);

  assert.deepEqual(verbs({ type: "reminder", id: "inb_1", title: "Позвонить" }),
    ["Готово", "+1 час", "Вечером", "🔊 Озвучить"]);
  assert.deepEqual(verbs({ type: "calendar", id: "inb_2", title: "Планёрка" }),
    ["Понятно", "🔊 Озвучить"], "a calendar alert with no route has nothing to open");
  assert.deepEqual(verbs({ kind: "erp-anomaly", id: "erp_1", title: "Выработка", route: "erp" }),
    ["Понятно", "Открыть", "🔊 Озвучить"]);
  // Listening was the one thing this bot could already do and people use it on
  // the factory floor. It stays on every card.
  for (const item of [{ type: "task", id: "a" }, { type: "message", id: "b" }, { kind: "lead", id: "c" }]) {
    assert.ok(verbs({ ...item, title: "x" }).includes("🔊 Озвучить"));
  }
});

test("the brief is recognised by behaviour, because nothing on it says brief", () => {
  // The morning brief arrives as a plain item whose only distinguishing mark is
  // speak:true. It is the message most people read every day.
  assert.equal(cardKindOf({ speak: true, title: "План на 22 августа" }), "brief");
  assert.equal(cardKindOf({ type: "reminder" }), "reminder");
  assert.equal(cardKindOf({ kind: "erp-weekly" }), "erp-weekly");
  assert.equal(cardKindOf({ kind: "something-nobody-added-yet" }), "system",
    "an unknown kind still delivers, as a plain notice");
});

test("Open points at the route the item already carries", () => {
  const card = buildCard({ type: "task", id: "inb_1", title: "x", route: "my-tasks" },
    { publicUrl: "https://agent.milanapremium.uz/" });
  const open = card.keyboard.inline_keyboard.flat().find((b) => b.text === "Открыть");
  assert.equal(open.url, "https://agent.milanapremium.uz/?start=my-tasks");
  // ?start= is how index.html has taken a route since the Telegram links first
  // existed; the hash cannot be used because Telegram puts init data there.
  const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  void index;
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  assert.match(app, /searchParams\)?\.?get\("start"\)|get\("start"\)/);
});

test("an item with nothing in it sends nothing", () => {
  assert.equal(buildCard({ type: "task", id: "inb_1" }), null);
  assert.equal(buildCard({}), null);
});

/* ---------------- callback payloads ---------------- */

test("a button press fits in the 64 bytes Telegram allows, or it is not offered", () => {
  const id = "inb_0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
  const done = encodeCallback("d", id);
  assert.ok(Buffer.byteLength(done, "utf8") <= CALLBACK_LIMIT);
  assert.deepEqual(parseCallback(done), { action: "d", arg: "", id });

  const snooze = encodeCallback("s", id, "60");
  assert.ok(Buffer.byteLength(snooze, "utf8") <= CALLBACK_LIMIT);
  assert.deepEqual(parseCallback(snooze), { action: "s", arg: "60", id });

  // Over budget the answer is no button, never a truncated one: a truncated id
  // decodes into a lookup for something that does not exist, so the person taps
  // and nothing happens with no way to tell why.
  const huge = `inb_${"x".repeat(80)}`;
  assert.equal(encodeCallback("d", huge), null);
  const card = buildCard({ type: "reminder", id: huge, title: "Позвонить" });
  assert.deepEqual(card.keyboard.inline_keyboard.flat().map((b) => b.text), ["🔊 Озвучить"]);
});

test("a payload from an older format decodes as nothing rather than as the wrong verb", () => {
  assert.equal(parseCallback("d|inb_1"), null, "no version prefix");
  assert.equal(parseCallback("2|d|inb_1"), null, "a version this build does not know");
  assert.equal(parseCallback(""), null);
  assert.equal(parseCallback(undefined), null);
  assert.equal(parseCallback("speak"), null, "the speak button is handled before this");
});

/* ---------------- language ---------------- */

test("the card is in the reader's language, not the server's", async () => {
  for (const [locale, done, listen] of [
    ["ru-RU", "Готово", "🔊 Озвучить"],
    ["en-US", "Done", "🔊 Listen"],
    ["uz-UZ", "Bajarildi", "🔊 Ovoz chiqarib o‘qish"],
  ]) {
    const h = harness({ locale });
    await h.link();
    await h.instance.sendCard(OWNER.id, { type: "reminder", id: "inb_1", title: "Позвонить" });
    const labels = h.sent()[0].body.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(labels.includes(done), `${locale}: expected ${done} in ${labels.join(", ")}`);
    assert.ok(labels.includes(listen), `${locale}: expected ${listen}`);
    h.cleanup();
  }
});

test("the slash menu is published for every language the app speaks", () => {
  assert.deepEqual(commandList("ru-RU").map((c) => c.command),
    ["today", "tasks", "erp", "ask", "help", "stop"]);
  assert.equal(commandList("en-US").find((c) => c.command === "today").description, "Today's plan");
  assert.equal(commandList("uz-UZ").find((c) => c.command === "stop").description, "Bu chatni uzish");
  for (const locale of ["ru-RU", "en-US", "uz-UZ"]) {
    for (const entry of commandList(locale)) {
      assert.ok(!entry.description.startsWith("telegram."), `${entry.command} is untranslated in ${locale}`);
    }
  }
});

/* ---------------- the verbs actually do something ---------------- */

test("Done archives the item and takes the buttons off", async () => {
  const h = harness();
  await h.link();
  const item = h.workspaces.createInboxItem(OWNER.id, { type: "reminder", title: "Позвонить на склад" });
  await h.instance.sendCard(OWNER.id, item);
  const data = h.sent()[0].body.reply_markup.inline_keyboard.flat()
    .find((b) => b.text === "Готово").callback_data;

  await h.instance.handleUpdateForTest({
    callback_query: { id: "cb1", data, message: { chat: { id: CHAT }, message_id: 42 } },
  });

  assert.equal(h.workspaces.listInbox(OWNER.id, { limit: 50 }).find((i) => i.id === item.id).status, "archived");
  const answer = h.calls.find((c) => c.method === "answerCallbackQuery");
  assert.match(answer.body.text, /выполненное/);
  // The buttons come off so the card cannot be completed twice and reads as
  // settled in the scrollback.
  const edited = h.calls.find((c) => c.method === "editMessageReplyMarkup");
  assert.deepEqual(edited.body.reply_markup, { inline_keyboard: [] });
  h.cleanup();
});

test("Got it clears it from unread without archiving it", async () => {
  const h = harness();
  await h.link();
  const item = h.workspaces.createInboxItem(OWNER.id, { type: "calendar", title: "Планёрка" });
  await h.instance.sendCard(OWNER.id, item);
  const data = h.sent()[0].body.reply_markup.inline_keyboard.flat()
    .find((b) => b.text === "Понятно").callback_data;

  await h.instance.handleUpdateForTest({
    callback_query: { id: "cb2", data, message: { chat: { id: CHAT }, message_id: 42 } },
  });
  assert.equal(h.workspaces.listInbox(OWNER.id, { limit: 50 }).find((i) => i.id === item.id).status, "read");
  h.cleanup();
});

test("+1 hour books a real reminder and clears the card", async () => {
  const h = harness();
  await h.link();
  const item = h.workspaces.createInboxItem(OWNER.id, { type: "reminder", title: "Позвонить на склад", route: "personal" });
  await h.instance.sendCard(OWNER.id, item);
  const data = h.sent()[0].body.reply_markup.inline_keyboard.flat()
    .find((b) => b.text === "+1 час").callback_data;

  const before = Date.now();
  await h.instance.handleUpdateForTest({
    callback_query: { id: "cb3", data, message: { chat: { id: CHAT }, message_id: 42 } },
  });

  assert.equal(h.created.length, 1, "snoozing has to create something, or the reminder is simply lost");
  assert.equal(h.created[0].userId, OWNER.id);
  assert.equal(h.created[0].title, "Позвонить на склад");
  const gap = new Date(h.created[0].dueAt).getTime() - before;
  assert.ok(gap > 55 * 60000 && gap < 65 * 60000, `expected about an hour, got ${Math.round(gap / 60000)} minutes`);
  assert.equal(h.workspaces.listInbox(OWNER.id, { limit: 50 }).find((i) => i.id === item.id).status, "archived");
  h.cleanup();
});

test("Tonight means tonight where the person is", async () => {
  // The factory is in Andijan and the owner is not always there. An evening
  // computed on the server's clock would land mid-afternoon or after midnight.
  const h = harness({ timezone: "Europe/London" });
  await h.link();
  const item = h.workspaces.createInboxItem(OWNER.id, { type: "reminder", title: "Проверить отгрузку" });
  await h.instance.sendCard(OWNER.id, item);
  const data = h.sent()[0].body.reply_markup.inline_keyboard.flat()
    .find((b) => b.text === "Вечером").callback_data;

  await h.instance.handleUpdateForTest({
    callback_query: { id: "cb4", data, message: { chat: { id: CHAT }, message_id: 42 } },
  });
  assert.equal(h.created.length, 1);
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(h.created[0].dueAt));
  assert.equal(local, "19:00");
  h.cleanup();
});

test("a verb aimed at something that no longer exists says so", async () => {
  const h = harness();
  await h.link();
  const data = encodeCallback("d", "inb_gone");
  await h.instance.handleUpdateForTest({
    callback_query: { id: "cb5", data, message: { chat: { id: CHAT }, message_id: 42 } },
  });
  const answer = h.calls.find((c) => c.method === "answerCallbackQuery");
  assert.match(answer.body.text, /Не нашла/);
  h.cleanup();
});

test("a stranger's button press reaches no inbox of ours", async () => {
  // The same rule as every other inbound event. The chat is the credential, so
  // a press from a chat nobody linked is a press from nobody.
  const h = harness();
  await h.link();
  const item = h.workspaces.createInboxItem(OWNER.id, { type: "reminder", title: "Позвонить" });
  const data = encodeCallback("d", item.id);

  await h.instance.handleUpdateForTest({
    callback_query: { id: "cb6", data, message: { chat: { id: 999 }, message_id: 7 } },
  });
  assert.equal(h.workspaces.listInbox(OWNER.id, { limit: 50 }).find((i) => i.id === item.id).status, "unread",
    "the owner's item must be untouched by a chat that is not theirs");
  const answer = h.calls.find((c) => c.method === "answerCallbackQuery");
  assert.match(answer.body.text, /не привязан/);
  h.cleanup();
});

/* ---------------- delivery ---------------- */

test("the brief still arrives written first and spoken after", async () => {
  const h = harness();
  await h.link();
  await h.instance.sendCard(OWNER.id, { id: "brief_1", title: "План на 22 августа", body: "Три встречи", speak: true });
  const methods = h.calls.map((c) => c.method);
  assert.ok(methods.indexOf("sendMessage") < methods.indexOf("sendVoice"),
    "a voice message cannot be searched, quoted or read in a meeting; the text goes first");
  assert.match(h.sent()[0].body.text, /☀️ <b>План на 22 августа<\/b>/);
  h.cleanup();
});

test("nothing leaves for a chat nobody linked", async () => {
  const h = harness();
  assert.equal(await h.instance.sendCard("usr_unlinked", { type: "task", id: "inb_1", title: "x" }), false);
  assert.equal(h.calls.length, 0);
  h.cleanup();
});

test("/today is put to MILA rather than answered by a second code path", async () => {
  // Three commands are questions. Routing them through the assistant means they
  // inherit her tools, her audience gate and her tone, instead of growing a
  // parallel answering path that drifts.
  const asked = [];
  const h = harness();
  h.instance.assistant = { respond: async (userId, text) => { asked.push({ userId, text }); return "Три встречи."; } };
  await h.link();
  await h.instance.handleUpdateForTest({ message: { chat: { id: CHAT }, text: "/today" } });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].userId, OWNER.id);
  assert.match(asked[0].text, /сегодня/i);
  assert.equal(h.sent().at(-1).body.text, "Три встречи.");
  h.cleanup();
});

test("/today from an unlinked chat asks nothing of MILA", async () => {
  const asked = [];
  const h = harness();
  h.instance.assistant = { respond: async () => { asked.push(1); return "leak"; } };
  await h.instance.handleUpdateForTest({ message: { chat: { id: 999 }, text: "/today" } });
  assert.deepEqual(asked, []);
  assert.match(h.sent()[0].body.text, /привязанным/);
  h.cleanup();
});
