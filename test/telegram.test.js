// Telegram delivery, consent-first.
//
// The invariant everything here defends: a message leaves for exactly one chat,
// the one its owner linked themselves. No argument anywhere accepts a chat id.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemberWorkspaceStore } from "../server/lib/member-workspace.js";
import { TelegramBridge } from "../server/lib/telegram.js";
import { createMilaActions, PERSONAL_ACTIONS } from "../server/lib/mila-actions.js";
import { MILA_MEMBER_TOOLS, MILA_TOOLS } from "../assets/js/mila-tools.js";
import { buildMilaSystemInstruction } from "../assets/js/mila-prompt.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };
const OTHER = { id: "usr_2", name: "Шавкат", role: "Member" };

function bridge({ token = "test-token" } = {}) {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-tg-"));
  const instance = new TelegramBridge({
    file: path.join(dir, "links.json"),
    integrations: () => ({ botToken: token }),
    fetch: async (url, options) => {
      const method = url.split("/").pop();
      const body = JSON.parse(options.body || "{}");
      calls.push({ method, body });
      const result = method === "getMe" ? { username: "milana_mila_bot" } : { message_id: calls.length };
      return { ok: true, json: async () => ({ ok: true, result }) };
    },
  });
  return { instance, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}


test("the deep link binds the chat that used it, and only to its issuer", async () => {
  const b = bridge();
  const { url } = await b.instance.issueLinkCode(OWNER);
  assert.match(url, /^https:\/\/t\.me\/milana_mila_bot\?start=/);
  const code = url.split("start=")[1];

  // The chat that sends /start <code> becomes the link for the code's issuer.
  await b.instance.handleUpdateForTest({ message: { chat: { id: 777 }, from: { username: "bakhadyr" }, text: `/start ${code}` } });
  assert.deepEqual(b.instance.link(OWNER.id), { linked: true, username: "bakhadyr", linkedAt: b.instance.link(OWNER.id).linkedAt });

  // A used or invented code links nobody and says so in the chat.
  await b.instance.handleUpdateForTest({ message: { chat: { id: 888 }, text: `/start ${code}` } });
  assert.equal(b.instance.link(OTHER.id).linked, false);
  const refused = b.calls.filter((call) => call.method === "sendMessage" && call.body.chat_id === 888);
  assert.match(refused[0].body.text, /устарела/);
  b.cleanup();
});

test("sending goes to the owner's linked chat and nowhere else", async () => {
  const b = bridge();
  const { url } = await b.instance.issueLinkCode(OWNER);
  await b.instance.handleUpdateForTest({ message: { chat: { id: 777 }, from: {}, text: `/start ${url.split("start=")[1]}` } });

  assert.equal(await b.instance.sendText(OWNER.id, "план дня"), true);
  const sent = b.calls.filter((call) => call.method === "sendMessage" && call.body.text === "план дня");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, 777);

  // No link — no delivery, and no error either: Telegram is optional transport.
  assert.equal(await b.instance.sendText(OTHER.id, "чужое"), false);
  assert.equal(b.calls.some((call) => call.body?.text === "чужое"), false);
  b.cleanup();
});

test("long content arrives whole, in parts", async () => {
  const b = bridge();
  const { url } = await b.instance.issueLinkCode(OWNER);
  await b.instance.handleUpdateForTest({ message: { chat: { id: 777 }, from: {}, text: `/start ${url.split("start=")[1]}` } });

  const long = "д".repeat(9000);
  await b.instance.sendText(OWNER.id, long);
  const parts = b.calls.filter((call) => call.method === "sendMessage" && call.body.chat_id === 777 && call.body.text.startsWith("д"));
  assert.equal(parts.length, 3, "9000 characters over a 4000 limit is three messages");
  assert.equal(parts.map((part) => part.body.text).join("").length, 9000);
  b.cleanup();
});

test("/stop unlinks, and relinking from a new chat replaces the old one", async () => {
  const b = bridge();
  let { url } = await b.instance.issueLinkCode(OWNER);
  await b.instance.handleUpdateForTest({ message: { chat: { id: 777 }, from: {}, text: `/start ${url.split("start=")[1]}` } });

  // The same account linking from a different Telegram moves the link — one
  // chat per account, never an accumulating audience.
  ({ url } = await b.instance.issueLinkCode(OWNER));
  await b.instance.handleUpdateForTest({ message: { chat: { id: 999 }, from: {}, text: `/start ${url.split("start=")[1]}` } });
  await b.instance.sendText(OWNER.id, "куда");
  const delivery = b.calls.filter((call) => call.body?.text === "куда");
  assert.deepEqual(delivery.map((call) => call.body.chat_id), [999]);

  await b.instance.handleUpdateForTest({ message: { chat: { id: 999 }, text: "/stop" } });
  assert.equal(b.instance.link(OWNER.id).linked, false);
  assert.equal(await b.instance.sendText(OWNER.id, "после отвязки"), false);
  b.cleanup();
});

test("removeUser exists and account deletion calls it", () => {
  const b = bridge();
  assert.equal(typeof b.instance.removeUser, "function");
  const lifecycle = fs.readFileSync(new URL("../server/lib/account-lifecycle.js", import.meta.url), "utf8");
  assert.match(lifecycle, /telegramStore\.removeUser\(id\)/);
  b.cleanup();
});

test("the MILA action reaches the caller's own chat only, and says when there is none", async () => {
  const b = bridge();
  const { url } = await b.instance.issueLinkCode(OWNER);
  await b.instance.handleUpdateForTest({ message: { chat: { id: 777 }, from: {}, text: `/start ${url.split("start=")[1]}` } });

  const actions = createMilaActions({
    telegram: b.instance,
    journal: { append: async () => null, recentText: () => "" },
    onboarding: { get: () => ({ profile: {} }) },
    db: { mcp: { list: () => [], update: () => {} } },
    memberWorkspaces: new MemberWorkspaceStore(fs.mkdtempSync(path.join(os.tmpdir(), "aos-ws-"))),
  });

  assert.ok(PERSONAL_ACTIONS.has("send_telegram"), "own-chat delivery is a personal action, so a Member gets it too");
  const sent = await actions.call("send_telegram", { text: "итог дня" }, { actor: OWNER.name, user: OWNER });
  assert.equal(sent.ok, true);
  assert.equal(b.calls.find((call) => call.body?.text === "итог дня").body.chat_id, 777);

  // The colleague has no link: the honest answer is "not linked", not silence
  // and not somebody else's chat.
  const unlinked = await actions.call("send_telegram", { text: "и мне" }, { actor: OTHER.name, user: OTHER });
  assert.equal(unlinked.ok, false);
  assert.equal(unlinked.linked, false);
  assert.equal(b.calls.some((call) => call.body?.text === "и мне"), false);
  b.cleanup();
});

test("the tool is declared everywhere with the same honesty rules", () => {
  assert.ok(MILA_TOOLS.some((tool) => tool.name === "send_telegram"));
  assert.ok(MILA_MEMBER_TOOLS.some((tool) => tool.name === "send_telegram"), "their own chat, so a Member keeps it");

  const prompt = buildMilaSystemInstruction({ tools: ["get_my_day_plan", "send_telegram"] });
  assert.match(prompt, /send_telegram/);
  assert.match(prompt, /do not claim anything was sent/);
  const without = buildMilaSystemInstruction({ tools: ["get_my_day_plan"] });
  assert.equal(without.includes("send_telegram"), false, "a surface without the tool is not told about it");
});

test("every notification rides along to a linked chat", () => {
  // sendInbox is the one door reminders, briefs and messenger pushes leave
  // through; telegram delivery lives inside it so nothing needs to remember to
  // call a second method.
  const source = fs.readFileSync(new URL("../server/lib/push-service.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async sendInbox"));
  assert.match(body, /telegram\s*\n?\s*\.sendText\(userId/);
  const noDevices = body.indexOf("if (!devices.length)");
  assert.ok(body.indexOf("telegram") < noDevices, "telegram must go first: no FCM devices used to end delivery entirely");
});

test("the telegram row exists for installs that predate it", () => {
  // The Integrations page renders db rows, not the PROVIDERS registry: a
  // provider registered only in connectors.js renders nowhere. The seed list is
  // what readOrSeed() backfills into existing databases on boot, so telegram
  // has to be in it — this is exactly how the card failed to appear the first
  // time, on a database seeded before the provider existed.
  const store = fs.readFileSync(new URL("../server/store.js", import.meta.url), "utf8");
  const seedList = store.match(/integrations: \[([^\]]+)\]\.map/)?.[1] || "";
  assert.match(seedList, /"telegram"/);
  const connectors = fs.readFileSync(new URL("../server/lib/connectors.js", import.meta.url), "utf8");
  for (const provider of seedList.match(/"([a-z]+)"/g).map((name) => name.replaceAll('"', ""))) {
    assert.ok(
      new RegExp(`^  ${provider}:`, "m").test(connectors),
      `${provider} is seeded as a row but has no PROVIDERS entry — it would render blank`,
    );
  }
});
