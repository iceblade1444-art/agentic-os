// What one person's agent knows must not become what the room knows.
//
// Every case here was found by auditing the shipped product, not imagined: each
// one was reachable over real HTTP by a role that exists and is assignable.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PersonalProfileStore } from "../server/lib/personal-profile.js";
import { ReminderStore } from "../server/lib/reminders.js";
import { Messenger } from "../server/lib/messenger.js";
import { createMilaActions } from "../server/lib/mila-actions.js";
import { createMilaResponder } from "../server/lib/messenger-mila.js";
import { createBroadcaster } from "../server/lib/messenger-broadcast.js";
import { sharedAgentContext } from "../server/lib/onboarding.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };
const COLLEAGUE = { id: "usr_2", name: "Шавкат", role: "Member" };

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("the day journal records that a private thing happened, never what it said", async () => {
  // Agentic OS/Journal/<date>.md is one file a day for the whole company. It is
  // readable through /api/knowledge by Creator, Admin *and* Design, and it is
  // fed into every operator's agent prompt. Private titles were going into it
  // verbatim, stamped with the author's name — so a Design account, which has no
  // route to anyone's notes, could read "Заметка: Развод — документы к юристу".
  const written = [];
  const actions = createMilaActions({
    journal: { append: async (entry) => { written.push(entry); return entry; }, recentText: () => "" },
    onboarding: { get: () => ({ profile: {} }) },
    personalFiles: null,
    db: { mcp: { list: () => [], update: () => {} } },
    reminders: new ReminderStore(path.join(tempDir("aos-rem-"), "reminders.json")),
    personalProfiles: new PersonalProfileStore(tempDir("aos-prof-")),
  });

  const secrets = [
    ["save_my_note", { title: "Развод — документы к юристу", content: "..." }],
    ["remind_me", { title: "Позвонить в клинику по результатам", dueAt: "2027-01-01T09:00:00+05:00" }],
  ];
  for (const [name, args] of secrets) {
    await actions.call(name, args, { actor: OWNER.name, user: OWNER });
  }

  assert.equal(written.length, secrets.length, "the action is still recorded — it is the content that is not");
  const everything = JSON.stringify(written);
  for (const [, args] of secrets) {
    assert.equal(
      everything.includes(args.title),
      false,
      `"${args.title}" reached a file the whole company reads`,
    );
  }
  // Still enough to see that the day had personal work in it.
  assert.match(everything, /личн/i);
});

test("in a channel she is not given the asker's profile or the day journal", async () => {
  const profiles = new PersonalProfileStore(tempDir("aos-prof-"));
  profiles.remember(COLLEAGUE.id, { fact: "Его дочь родилась в марте" });
  const state = {
    workspace: { completedAt: "2026-01-01T00:00:00.000Z", name: "Milana Premium" },
    profile: { timezone: "Asia/Tashkent" },
  };
  const options = {
    vault: os.tmpdir(),
    profiles,
    journal: { recentText: () => "Вчера: Иван взял отпуск по семейным причинам" },
  };
  const context = (user, _state, extra = {}) => sharedAgentContext(user, state, { ...options, ...extra });

  const prompts = [];
  const responder = createMilaResponder({
    db: { integrations: { byProvider: () => ({ config: { baseUrl: "http://mila.test" } }) } },
    chat: async (_cfg, _title, request) => { prompts.push(request.systemPrompt); return { text: "ок" }; },
    sharedAgentContext: context,
  });

  const history = [{ authorId: COLLEAGUE.id, authorName: COLLEAGUE.name, text: "@mila когда отгрузка?", kind: "user", mentions: [] }];
  await responder.reply({
    conversation: { id: "c1", kind: "channel", name: "производство", memberIds: [COLLEAGUE.id, "agent:mila"] },
    history,
    asker: { ...COLLEAGUE, role: "Creator" },
  });
  const channelPrompt = prompts.at(-1);
  assert.equal(channelPrompt.includes("дочь родилась"), false, "her reply is a message colleagues read");
  assert.equal(channelPrompt.includes("взял отпуск"), false, "the day journal carries what everyone else did");
  // She still knows where she is and who the company is.
  assert.match(channelPrompt, /Milana Premium/);

  // A direct thread is between her and one person, so it keeps both.
  await responder.reply({
    conversation: { id: "c2", kind: "direct", memberIds: [COLLEAGUE.id, "agent:mila"] },
    history,
    asker: { ...COLLEAGUE, role: "Creator" },
  });
  assert.match(prompts.at(-1), /дочь родилась/);
});

test("a brief only reaches a channel its owner is actually in", () => {
  const dir = tempDir("aos-msg-");
  const store = new Messenger(dir);
  const inside = store.createChannel(OWNER, { name: "производство", memberIds: [COLLEAGUE.id, "agent:mila"] });
  const outside = store.createChannel(OWNER, { name: "директора", memberIds: ["agent:mila"] });
  const channels = createBroadcaster({
    messenger: store,
    onboarding: { get: () => ({ profile: { briefChannel: "директора" } }) },
  });

  // The channel name is free text in the person's own profile. Naming a room
  // they are not in used to publish their day plan there, signed "Mila".
  assert.equal(channels.post("директора", "план дня Шавката", { onBehalfOf: COLLEAGUE }), null);
  assert.equal(store.messages(outside.id, OWNER.id).messages.length, 0);

  const posted = channels.post("производство", "план дня Шавката", { onBehalfOf: COLLEAGUE });
  assert.ok(posted, "a room they are in is fine");
  assert.equal(store.messages(inside.id, COLLEAGUE.id).messages.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("deleting an account takes its reminders and its threads with it", () => {
  const remindersFile = path.join(tempDir("aos-rem-"), "reminders.json");
  const reminders = new ReminderStore(remindersFile);
  reminders.create(COLLEAGUE.id, { title: "Позвонить в клинику", dueAt: "2027-01-01T09:00:00+05:00" });
  assert.equal(reminders.list(COLLEAGUE.id).length, 1);
  assert.equal(reminders.removeUser(COLLEAGUE.id), 1);
  assert.deepEqual(reminders.list(COLLEAGUE.id), []);
  assert.equal(reminders.removeUser(COLLEAGUE.id), 0, "removing twice is not an error to hide");

  const dir = tempDir("aos-msg-");
  const store = new Messenger(dir);
  const channel = store.createChannel(OWNER, { name: "производство", memberIds: [COLLEAGUE.id] });
  const direct = store.openDirect(OWNER, COLLEAGUE.id);
  store.send(direct.id, OWNER, { text: "привет" });
  store.markRead(COLLEAGUE.id, channel.id);

  store.removeUser(COLLEAGUE.id);

  // The channel header counts raw ids and the member list resolves them against
  // the directory, so a leftover id showed "3 members" above a list of 2.
  const after = store.listFor(OWNER.id).find((item) => item.id === channel.id);
  assert.equal(after.memberIds.includes(COLLEAGUE.id), false);
  // A one-sided direct thread is a room you can write into forever with nobody
  // on the other end.
  assert.equal(store.listFor(OWNER.id).some((item) => item.id === direct.id), false);
  assert.equal(fs.existsSync(path.join(dir, `messages-${direct.id}.json`)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("account deletion actually calls both", () => {
  const source = fs.readFileSync(new URL("../server/lib/account-lifecycle.js", import.meta.url), "utf8");
  assert.match(source, /reminderStore\.removeUser\(id\)/);
  assert.match(source, /messengerStore\.removeUser\(id\)/);
});
