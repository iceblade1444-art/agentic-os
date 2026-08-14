// The recap can only summarize a room its reader can open.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Messenger } from "../server/lib/messenger.js";
import { createMessengerRecap } from "../server/lib/messenger-recap.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };
const MEMBER = { id: "usr_2", name: "Шавкат", role: "Member" };
const OUTSIDER = { id: "usr_3", name: "Чужой", role: "Member" };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-recap-"));
  const store = new Messenger(dir);
  const prompts = [];
  const instance = createMessengerRecap({
    messenger: store,
    chat: async (_cfg, _label, request) => { prompts.push(request); return { text: "— Отгрузка перенесена на 20-е.\nЖдут от вас: подтвердить сертификаты." }; },
    milaConfig: () => ({ baseUrl: "http://mila.test" }),
  });
  return { store, instance, prompts, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a member gets a recap; a non-member gets the messenger's own 403", async () => {
  const f = fixture();
  const channel = f.store.createChannel(OWNER, { name: "производство", memberIds: [MEMBER.id] });
  for (let i = 0; i < 5; i += 1) f.store.send(channel.id, OWNER, { text: `сообщение ${i} про отгрузку` });

  const result = await f.instance.recap(MEMBER, channel.id);
  assert.match(result.recap, /Отгрузка перенесена/);
  assert.equal(result.covered, 5);
  // The reader's own lines are labelled for the model.
  f.store.send(channel.id, MEMBER, { text: "я подтверждаю" });
  await f.instance.recap(MEMBER, channel.id);
  assert.match(f.prompts.at(-1).messages[0].content, /Шавкат \(это вы\): я подтверждаю/);

  await assert.rejects(f.instance.recap(OUTSIDER, channel.id), (error) => error.status === 403);
  f.cleanup();
});

test("a nearly-empty thread says so instead of inventing a recap", async () => {
  const f = fixture();
  const channel = f.store.createChannel(OWNER, { name: "тихий", memberIds: [MEMBER.id] });
  f.store.send(channel.id, OWNER, { text: "привет" });
  const result = await f.instance.recap(MEMBER, channel.id);
  assert.equal(result.recap, "");
  assert.match(result.note, /нечего/);
  assert.equal(f.prompts.length, 0, "no model call for nothing");
  f.cleanup();
});
