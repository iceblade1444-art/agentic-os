import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MessengerFiles } from "../server/lib/messenger-files.js";
import { createBroadcaster } from "../server/lib/messenger-broadcast.js";
import { Messenger, MILA_MEMBER_ID } from "../server/lib/messenger.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };

function files() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-mfiles-"));
  return { dir, store: new MessengerFiles(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const base64 = (text) => Buffer.from(text).toString("base64");

test("a filename is metadata, never a path", () => {
  const f = files();
  const item = f.store.add("cnv_1", { name: "../../.env", type: "text/plain", base64: base64("hello") });
  // Stored as <uuid>.bin: the name someone typed cannot reach outside the folder.
  assert.equal(item.name.includes(".."), false);
  const stored = fs.readdirSync(path.join(f.dir, "cnv_1"));
  assert.deepEqual(stored.filter((name) => name.endsWith(".bin")), [`${item.id}.bin`]);
  assert.equal(fs.existsSync(path.join(f.dir, ".env")), false);
  f.cleanup();
});

test("a conversation id cannot escape the storage directory either", () => {
  const f = files();
  assert.throws(() => f.store.add("../../etc", { name: "x", base64: base64("x") }), (error) => error.status === 400);
  f.cleanup();
});

test("kind is decided by type, so the client renders the right thing", () => {
  const f = files();
  const image = f.store.add("c", { name: "photo.jpg", type: "image/jpeg", base64: base64("img") });
  const voice = f.store.add("c", { name: "voice.webm", type: "audio/webm", base64: base64("snd"), duration: 4.6, transcript: "нужен упаковочный лист" });
  const other = f.store.add("c", { name: "list.pdf", type: "application/pdf", base64: base64("pdf") });
  assert.equal(image.kind, "image");
  assert.equal(voice.kind, "audio");
  assert.equal(other.kind, "file");
  // A voice note carries its own transcript so it is readable and searchable
  // by someone who cannot listen right now.
  assert.equal(voice.duration, 5);
  assert.equal(voice.transcript, "нужен упаковочный лист");
  f.cleanup();
});

test("empty and oversized uploads are refused before anything is written", () => {
  const f = files();
  assert.throws(() => f.store.add("c", { name: "x", base64: "" }), (error) => error.status === 400);
  const huge = Buffer.alloc(13 * 1024 * 1024).toString("base64");
  assert.throws(() => f.store.add("c", { name: "big.bin", base64: huge }), (error) => error.status === 413);
  assert.equal(fs.existsSync(path.join(f.dir, "c")), false, "nothing is created for a rejected upload");
  f.cleanup();
});

test("a stored file reads back byte for byte", () => {
  const f = files();
  const item = f.store.add("c", { name: "note.txt", type: "text/plain", base64: base64("накладная") });
  assert.equal(f.store.get("c", item.id).buffer.toString(), "накладная");
  assert.throws(() => f.store.get("c", "missing"), (error) => error.status === 404);
  f.cleanup();
});

// ---------- MILA posting on her own ----------

function broadcastFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-broadcast-"));
  const messenger = new Messenger(dir);
  return {
    dir,
    messenger,
    make: (profile = {}) => createBroadcaster({ messenger, onboarding: { get: () => ({ profile }) } }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("MILA posts into a named channel she belongs to", () => {
  const b = broadcastFixture();
  const channel = b.messenger.createChannel(OWNER, { name: "Общий", memberIds: [MILA_MEMBER_ID] });
  const posted = b.make().post("Общий", "План на сегодня: срочного нет.");
  assert.ok(posted);
  assert.equal(posted.authorId, MILA_MEMBER_ID);
  assert.equal(posted.kind, "agent");
  // It lands in the channel itself, where the team reads it.
  const thread = b.messenger.messages(channel.id, OWNER.id).messages;
  assert.equal(thread.length, 1);
  assert.match(thread[0].text, /План на сегодня/);
  b.cleanup();
});

test("she stays silent rather than inventing a destination", () => {
  const b = broadcastFixture();
  // No such channel at all.
  assert.equal(b.make().post("Производство", "текст"), null);

  // The channel exists but she was never added — which is how the team turns
  // automatic posts off: remove her and they stop.
  b.messenger.createChannel(OWNER, { name: "Производство" });
  assert.equal(b.make().post("Производство", "текст"), null);
  assert.equal(b.make().post("Производство", "   "), null, "an empty brief is not worth a message");
  b.cleanup();
});

test("automatic posting is opt-in: no channel configured, nothing broadcast", () => {
  const b = broadcastFixture();
  assert.equal(b.make({}).briefChannel(OWNER), "");
  assert.equal(b.make({ briefChannel: "Общий" }).briefChannel(OWNER), "Общий");
  assert.equal(b.make({ alertChannel: "Производство" }).alertChannel(OWNER), "Производство");
  b.cleanup();
});

test("channel lookup by name ignores case and stray spacing", () => {
  const b = broadcastFixture();
  b.messenger.createChannel(OWNER, { name: "Производство", memberIds: [MILA_MEMBER_ID] });
  const broadcaster = b.make();
  assert.ok(broadcaster.targetChannel("производство"));
  assert.ok(broadcaster.targetChannel("  Производство  "));
  assert.equal(broadcaster.targetChannel("Производств"), null);
  b.cleanup();
});
