import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Messenger, parseMentions, MILA_MEMBER_ID } from "../server/lib/messenger.js";
import { createMilaResponder, shouldMilaAnswer } from "../server/lib/messenger-mila.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };
const BAHADIR = { id: "usr_1", name: "Bahadir Yakubov", role: "Member" };
const SHAVKAT = { id: "usr_2", name: "Shavkat Mirzaev", role: "Member" };
const MILA = { id: MILA_MEMBER_ID, name: "Mila" };

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-messenger-"));
  return { dir, messenger: new Messenger(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a channel is readable only by its members", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Производство", memberIds: [BAHADIR.id] });
  s.messenger.send(channel.id, OWNER, { text: "Отгрузка в четверг" });

  assert.equal(s.messenger.messages(channel.id, BAHADIR.id).messages.length, 1);
  // Not a member: not merely an empty list, an explicit refusal.
  assert.throws(() => s.messenger.messages(channel.id, SHAVKAT.id), (error) => error.status === 403);
  assert.throws(() => s.messenger.send(channel.id, SHAVKAT, { text: "подслушал" }), (error) => error.status === 403);
  assert.equal(s.messenger.listFor(SHAVKAT.id).length, 0);
  s.cleanup();
});

test("a direct thread is found again instead of being created twice", () => {
  const s = store();
  const first = s.messenger.openDirect(BAHADIR, SHAVKAT.id);
  // The other person opening it from their side must land in the same thread,
  // or two people end up talking past each other in two histories.
  const second = s.messenger.openDirect(SHAVKAT, BAHADIR.id);
  assert.equal(first.id, second.id);

  assert.throws(() => s.messenger.openDirect(BAHADIR, BAHADIR.id), /yourself/i);
  assert.throws(() => s.messenger.openDirect(BAHADIR, ""), /someone/i);
  s.cleanup();
});

test("unread counts follow the reader, not the writer", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Отгрузки", memberIds: [BAHADIR.id] });
  s.messenger.send(channel.id, OWNER, { text: "первое" });
  s.messenger.send(channel.id, OWNER, { text: "второе" });

  // The author has read what they just wrote.
  assert.equal(s.messenger.listFor(OWNER.id)[0].unread, 0);
  assert.equal(s.messenger.listFor(BAHADIR.id)[0].unread, 2);
  assert.equal(s.messenger.unreadTotal(BAHADIR.id), 2);

  s.messenger.markRead(BAHADIR.id, channel.id);
  assert.equal(s.messenger.listFor(BAHADIR.id)[0].unread, 0);

  s.messenger.send(channel.id, BAHADIR, { text: "принял" });
  assert.equal(s.messenger.listFor(BAHADIR.id)[0].unread, 0, "your own reply is not unread for you");
  assert.equal(s.messenger.listFor(OWNER.id)[0].unread, 1);
  s.cleanup();
});

test("conversations are ordered by the latest message, even within one millisecond", () => {
  const s = store();
  const first = s.messenger.createChannel(OWNER, { name: "Первый", memberIds: [BAHADIR.id] });
  const second = s.messenger.createChannel(OWNER, { name: "Второй", memberIds: [BAHADIR.id] });
  // Sent faster than the clock ticks: without strictly increasing stamps the
  // order of a burst is undefined and the list jumps around at random.
  s.messenger.send(first.id, OWNER, { text: "старое" });
  s.messenger.send(second.id, OWNER, { text: "новое" });
  assert.equal(s.messenger.listFor(BAHADIR.id)[0].id, second.id);

  const stamps = [];
  for (let i = 0; i < 20; i += 1) stamps.push(s.messenger.send(first.id, OWNER, { text: `${i}` }).createdAt);
  assert.equal(new Set(stamps).size, stamps.length, "no two messages may share a timestamp");
  assert.deepEqual([...stamps].sort(), stamps, "timestamps must increase monotonically");
  assert.equal(s.messenger.listFor(BAHADIR.id)[0].id, first.id);
  s.cleanup();
});

test("a burst is not lost to the read watermark", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Быстрый", memberIds: [BAHADIR.id] });
  s.messenger.markRead(BAHADIR.id, channel.id);
  // Written in the same millisecond as the mark: a message landing exactly on
  // the watermark used to be counted as already read.
  for (let i = 0; i < 5; i += 1) s.messenger.send(channel.id, OWNER, { text: `${i}` });
  assert.equal(s.messenger.listFor(BAHADIR.id)[0].unread, 5);
  s.cleanup();
});

test("membership changes are the access control, and only the owner makes them", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Закупки", memberIds: [BAHADIR.id] });

  // A member may retitle, but may not let themselves invite others in.
  s.messenger.updateChannel(BAHADIR, channel.id, { name: "Закупки и склад" });
  assert.equal(s.messenger.listFor(BAHADIR.id)[0].name, "Закупки и склад");
  assert.throws(
    () => s.messenger.updateChannel(BAHADIR, channel.id, { memberIds: [BAHADIR.id, SHAVKAT.id] }),
    (error) => error.status === 403,
  );

  const updated = s.messenger.updateChannel(OWNER, channel.id, { memberIds: [BAHADIR.id, SHAVKAT.id] });
  assert.ok(updated.memberIds.includes(SHAVKAT.id));
  // The creator cannot be dropped by a member list that omits them.
  assert.ok(updated.memberIds.includes(OWNER.id));
  s.cleanup();
});

test("input is bounded and empty messages are refused", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Общий" });
  assert.throws(() => s.messenger.send(channel.id, OWNER, { text: "   " }), /empty/i);
  assert.throws(() => s.messenger.createChannel(OWNER, { name: "x" }), /2 characters/i);

  const long = s.messenger.send(channel.id, OWNER, { text: "я".repeat(9000) });
  assert.equal(long.text.length, 4000);
  s.cleanup();
});

test("a conversation id cannot escape the storage directory", () => {
  const s = store();
  assert.throws(() => s.messenger.messages("../../etc/passwd", OWNER.id), (error) => error.status === 404);
  assert.equal(fs.readdirSync(s.dir).every((name) => !name.includes("..")), true);
  s.cleanup();
});

test("mentions resolve against the people actually in the room", () => {
  const members = [
    { id: BAHADIR.id, name: "Bahadir Yakubov", handle: "bahadir" },
    { id: MILA_MEMBER_ID, name: "Mila", handle: "mila" },
  ];
  assert.deepEqual(parseMentions("@mila посмотри просрочки", members), [MILA_MEMBER_ID]);
  assert.deepEqual(parseMentions("@bahadir глянь", members), [BAHADIR.id]);
  // An address is not a mention, and a name nobody in the room has resolves to
  // nobody rather than to the closest match.
  assert.deepEqual(parseMentions("пиши на mila@example.com", members), []);
  assert.deepEqual(parseMentions("@shavkat подтверди", members), []);
  assert.deepEqual(parseMentions("цена 100@шт", members), []);
});

test("MILA answers when addressed and stays out of the way otherwise", () => {
  const channel = { id: "c1", kind: "channel", name: "Производство", memberIds: [OWNER.id, MILA_MEMBER_ID] };
  const direct = { id: "c2", kind: "direct", memberIds: [OWNER.id, MILA_MEMBER_ID] };
  const human = { id: "c3", kind: "channel", name: "Только люди", memberIds: [OWNER.id, BAHADIR.id] };
  const message = (over = {}) => ({ authorId: OWNER.id, kind: "user", mentions: [], text: "привет", ...over });

  assert.equal(shouldMilaAnswer(channel, message({ mentions: [MILA_MEMBER_ID] })), true);
  // Chatter in a channel she happens to be in is not a question for her.
  assert.equal(shouldMilaAnswer(channel, message()), false);
  assert.equal(shouldMilaAnswer(direct, message()), true, "a private thread with her is all hers");
  assert.equal(shouldMilaAnswer(human, message({ mentions: [MILA_MEMBER_ID] })), false, "she is not in this channel");
  // She never answers herself, which would loop forever.
  assert.equal(shouldMilaAnswer(direct, message({ authorId: MILA_MEMBER_ID, kind: "agent" })), false);
  assert.equal(shouldMilaAnswer(channel, message({ kind: "system", mentions: [MILA_MEMBER_ID] })), false);
});

test("MILA's reply carries who said what and never invents company facts", async () => {
  const captured = {};
  const responder = createMilaResponder({
    db: { integrations: { byProvider: () => ({ config: { baseUrl: "https://mila.example" } }) } },
    sharedAgentContext: () => "Workspace: Milana Premium",
    chat: async (cfg, label, options) => { Object.assign(captured, { cfg, label, options }); return { text: "  Проверила: просрочек нет.  " }; },
  });

  const conversation = { id: "c1", kind: "channel", name: "Производство", memberIds: [OWNER.id, MILA_MEMBER_ID] };
  const history = [
    { authorId: BAHADIR.id, authorName: "Bahadir", text: "когда отгрузка?" },
    { authorId: MILA_MEMBER_ID, authorName: "Mila", text: "уточняю" },
    { authorId: OWNER.id, authorName: "Бахадыр", text: "@mila проверь просрочки" },
  ];
  const text = await responder.reply({ conversation, history, asker: OWNER });
  assert.equal(text, "Проверила: просрочек нет.");

  // A channel is a group: without the author on each turn she answers the wrong
  // person.
  assert.equal(captured.options.messages[0].content, "Bahadir: когда отгрузка?");
  assert.equal(captured.options.messages[1].role, "assistant");
  assert.equal(captured.options.messages[1].content, "уточняю");
  assert.match(captured.options.systemPrompt, /team channel "Производство"/);
  assert.match(captured.options.systemPrompt, /never invent facts about the company/);
  assert.match(captured.options.systemPrompt, /Workspace: Milana Premium/);
  // No tools are reachable from a chat thread, so the prompt must not promise any.
  assert.equal(captured.options.systemPrompt.includes("get_my_day_plan"), false);
});

test("an unconfigured MILA backend fails loudly rather than posting silence", async () => {
  const responder = createMilaResponder({
    db: { integrations: { byProvider: () => ({ config: {} }) } },
    sharedAgentContext: () => "",
    chat: async () => { throw new Error("should not be called"); },
  });
  await assert.rejects(
    responder.reply({ conversation: { id: "c", kind: "direct", memberIds: [] }, history: [], asker: OWNER }),
    (error) => error.status === 503,
  );
});

test("agents are never push targets, because they have no phone", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Производство", memberIds: [BAHADIR.id, MILA_MEMBER_ID] });
  const conversation = s.messenger.listFor(OWNER.id)[0];
  assert.deepEqual(s.messenger.recipients(conversation, OWNER.id), [BAHADIR.id]);
  assert.deepEqual(s.messenger.recipients(conversation, MILA.id).sort(), [OWNER.id, BAHADIR.id].sort());
  s.cleanup();
});

test("a reply keeps an excerpt, and survives the original being deleted", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Отгрузки", memberIds: [BAHADIR.id] });
  const first = s.messenger.send(channel.id, OWNER, { text: "Нужен упаковочный лист на 240 мест" });
  const reply = s.messenger.send(channel.id, BAHADIR, { text: "Сделаю", replyToId: first.id });
  assert.equal(reply.replyTo.authorName, "Бахадыр");
  assert.match(reply.replyTo.excerpt, /упаковочный лист/);

  // The quote is a copy, so deleting the original leaves the reply readable
  // instead of turning it into an answer to nothing.
  s.messenger.remove(channel.id, first.id, OWNER);
  const after = s.messenger.messages(channel.id, BAHADIR.id).messages;
  assert.equal(after[0].deleted, true);
  assert.equal(after[0].text, "");
  assert.match(after[1].replyTo.excerpt, /упаковочный лист/);

  // Replying to something already gone is refused rather than silently dropped.
  assert.throws(() => s.messenger.send(channel.id, OWNER, { text: "поздно", replyToId: first.id }), (error) => error.status === 404);
  s.cleanup();
});

test("editing is the author's own, and only for a day", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Общий", memberIds: [BAHADIR.id] });
  const message = s.messenger.send(channel.id, OWNER, { text: "240 мест" });

  const edited = s.messenger.edit(channel.id, message.id, OWNER, "245 мест");
  assert.equal(edited.text, "245 мест");
  assert.ok(edited.editedAt, "an edit is visible, not silent");

  assert.throws(() => s.messenger.edit(channel.id, message.id, BAHADIR, "чужое"), (error) => error.status === 403);

  // Rewriting last week's message would change what a colleague already acted on.
  const old = s.messenger.send(channel.id, OWNER, { text: "старое" });
  const file = path.join(s.dir, `messages-${channel.id.replace(/[^a-zA-Z0-9_-]/g, "")}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.find((item) => item.id === old.id).createdAt = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => s.messenger.edit(channel.id, old.id, OWNER, "переписал"), (error) => error.status === 409);
  s.cleanup();
});

test("an operator can delete someone else's message, a colleague cannot", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Общий", memberIds: [BAHADIR.id, SHAVKAT.id] });
  const message = s.messenger.send(channel.id, BAHADIR, { text: "лишнее" });
  assert.throws(() => s.messenger.remove(channel.id, message.id, SHAVKAT), (error) => error.status === 403);
  assert.equal(s.messenger.remove(channel.id, message.id, OWNER).deleted, true);
  s.cleanup();
});

test("reactions toggle, and only from the agreed list", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Общий", memberIds: [BAHADIR.id] });
  const message = s.messenger.send(channel.id, OWNER, { text: "готово" });

  assert.deepEqual(s.messenger.react(channel.id, message.id, BAHADIR, "👍").reactions, { "👍": [BAHADIR.id] });
  const both = s.messenger.react(channel.id, message.id, OWNER, "👍");
  assert.deepEqual(both.reactions["👍"].sort(), [BAHADIR.id, OWNER.id].sort());
  // Tapping again takes it back, and the key disappears when nobody is left.
  assert.deepEqual(s.messenger.react(channel.id, message.id, BAHADIR, "👍").reactions["👍"], [OWNER.id]);
  assert.deepEqual(s.messenger.react(channel.id, message.id, OWNER, "👍").reactions, {});

  // Free text would be a second message channel with none of a message's rules.
  assert.throws(() => s.messenger.react(channel.id, message.id, OWNER, "<script>"), /Unsupported/);
  s.cleanup();
});

test("a message can carry attachments with no text, but not nothing at all", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Общий" });
  const photo = s.messenger.send(channel.id, OWNER, {
    attachments: [{ id: "f1", name: "накладная.jpg", kind: "image", type: "image/jpeg", size: 2048 }],
  });
  assert.equal(photo.text, "");
  assert.equal(photo.attachments.length, 1);
  assert.throws(() => s.messenger.send(channel.id, OWNER, {}), /empty/i);
  s.cleanup();
});

test("search reaches only conversations the reader is in", () => {
  const s = store();
  const mine = s.messenger.createChannel(OWNER, { name: "Мой", memberIds: [BAHADIR.id] });
  const theirs = s.messenger.createChannel(SHAVKAT, { name: "Чужой" });
  s.messenger.send(mine.id, OWNER, { text: "отгрузка в Алматы" });
  s.messenger.send(theirs.id, SHAVKAT, { text: "отгрузка секретная" });

  const found = s.messenger.search(BAHADIR.id, "отгрузка");
  assert.equal(found.length, 1);
  assert.match(found[0].message.text, /Алматы/);
  // Too short to be a search, and a deleted message is not a hit.
  assert.deepEqual(s.messenger.search(BAHADIR.id, "о"), []);
  s.cleanup();
});

test("leaving a channel is the one membership change a member makes alone", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Общий", memberIds: [BAHADIR.id] });
  s.messenger.leaveChannel(BAHADIR, channel.id);
  assert.equal(s.messenger.listFor(BAHADIR.id).length, 0);
  assert.throws(() => s.messenger.messages(channel.id, BAHADIR.id), (error) => error.status === 403);
  s.cleanup();
});

test("pinning points at a real message and clears when it is deleted", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Общий", memberIds: [BAHADIR.id] });
  const message = s.messenger.send(channel.id, OWNER, { text: "график смен" });
  assert.equal(s.messenger.pin(OWNER, channel.id, message.id).pinnedMessageId, message.id);
  assert.throws(() => s.messenger.pin(OWNER, channel.id, "msg_missing"), (error) => error.status === 404);

  s.messenger.remove(channel.id, message.id, OWNER);
  assert.equal(s.messenger.conversation(channel.id, OWNER.id).pinnedMessageId, "", "a pin must not outlive its message");
  s.cleanup();
});

test("mentions of you are flagged on the conversation, not just counted", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Общий", memberIds: [BAHADIR.id] });
  s.messenger.send(channel.id, OWNER, { text: "всем привет" });
  assert.equal(s.messenger.listFor(BAHADIR.id)[0].mentioned, false);
  s.messenger.send(channel.id, OWNER, { text: "@bahadir глянь", mentions: [BAHADIR.id] });
  assert.equal(s.messenger.listFor(BAHADIR.id)[0].mentioned, true);
  s.cleanup();
});

test("read receipts show how far others got, never the reader themselves", () => {
  const s = store();
  const channel = s.messenger.createChannel(OWNER, { name: "Общий", memberIds: [BAHADIR.id, MILA_MEMBER_ID] });
  s.messenger.send(channel.id, OWNER, { text: "проверьте" });
  s.messenger.markRead(BAHADIR.id, channel.id);

  const view = s.messenger.messages(channel.id, OWNER.id);
  assert.ok(view.readBy[BAHADIR.id], "a colleague's progress is visible");
  assert.equal(Object.hasOwn(view.readBy, OWNER.id), false, "your own watermark tells you nothing");
  // An assistant reading is meaningless, so it is not reported as a reader.
  assert.equal(Object.hasOwn(view.readBy, MILA_MEMBER_ID), false);
  s.cleanup();
});

test("live subscribers hear only what they are members of", () => {
  const s = store();
  const heard = [];
  s.messenger.on("message", ({ conversation, message }) => heard.push({ members: conversation.memberIds, text: message.text }));
  const channel = s.messenger.createChannel(OWNER, { name: "Закрытый", memberIds: [BAHADIR.id] });
  s.messenger.send(channel.id, OWNER, { text: "секрет" });

  assert.equal(heard.length, 1);
  // The event carries the membership so a stream can filter before sending.
  assert.equal(heard[0].members.includes(SHAVKAT.id), false);
  assert.equal(heard[0].members.includes(BAHADIR.id), true);
  s.cleanup();
});
