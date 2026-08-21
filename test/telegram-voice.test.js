// A voice note in Telegram is a question, not a dead end.
//
// Before this the handler read message.text, found none, and returned in
// silence — the person could not tell an ignored voice note from a dead bot.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TelegramBridge } from "../server/lib/telegram.js";
import { audioFileId, createVoiceTranscriber } from "../server/lib/telegram-voice.js";

function bridge({ voice, assistant } = {}) {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-tgv-"));
  const file = path.join(dir, "links.json");
  fs.writeFileSync(file, JSON.stringify({ creator: { chatId: 42, linkedAt: "2026-08-01T00:00:00.000Z" } }));
  const instance = new TelegramBridge({
    file,
    integrations: () => ({ botToken: "test-token" }),
    fetch: async (url, options) => {
      calls.push({ method: url.split("/").pop(), body: JSON.parse(options?.body || "{}") });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    },
    assistant: assistant || { respond: async (userId, text) => `эхо:${text}` },
    voice,
  });
  return { instance, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const voiceMessage = { chat: { id: 42 }, voice: { file_id: "AwACAgIx", duration: 4 } };

test("the audio a message can carry is recognised in every shape Telegram uses", () => {
  assert.equal(audioFileId(voiceMessage).fileId, "AwACAgIx");
  assert.equal(audioFileId({ audio: { file_id: "a1" } }).fileId, "a1");
  assert.equal(audioFileId({ video_note: { file_id: "v1" } }).fileId, "v1");
  assert.equal(audioFileId({ document: { file_id: "d1", mime_type: "audio/ogg" } }).fileId, "d1");
  assert.equal(audioFileId({ document: { file_id: "d2", mime_type: "application/pdf" } }), null);
  assert.equal(audioFileId({ text: "просто текст" }), null);
});

test("a voice note is transcribed and answered like a typed question", async () => {
  const asked = [];
  const { instance, calls, cleanup } = bridge({
    voice: { transcribe: async (token, fileId) => { asked.push({ token, fileId }); return "сколько сшили вчера"; } },
    assistant: { respond: async (userId, text) => { asked.push({ userId, text }); return "Вчера 6489 штук."; } },
  });

  await instance.handleUpdateForTest({ message: voiceMessage });

  assert.deepEqual(asked[0], { token: "test-token", fileId: "AwACAgIx" });
  assert.deepEqual(asked[1], { userId: "creator", text: "сколько сшили вчера" });
  const sent = calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);
  // The transcript is echoed so a mishearing is visible, then the answer.
  assert.match(sent[0], /сколько сшили вчера/);
  assert.equal(sent.at(-1), "Вчера 6489 штук.");
  cleanup();
});

test("a transcription that fails says so instead of going quiet", async () => {
  const { instance, calls, cleanup } = bridge({
    voice: { transcribe: async () => { throw new Error("speech service HTTP 503"); } },
    assistant: { respond: async () => { throw new Error("the assistant must not be reached"); } },
  });

  await instance.handleUpdateForTest({ message: voiceMessage });

  const sent = calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /напишите текстом/i);
  cleanup();
});

test("a photo gets an honest sentence, not silence", async () => {
  const { instance, calls, cleanup } = bridge({ voice: { transcribe: async () => "unused" } });
  await instance.handleUpdateForTest({ message: { chat: { id: 42 }, photo: [{ file_id: "p1" }] } });
  const sent = calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /только текст и голосовые/);
  cleanup();
});

test("a photo with a caption is answered by its caption", async () => {
  const seen = [];
  const { instance, cleanup } = bridge({
    voice: { transcribe: async () => "unused" },
    assistant: { respond: async (userId, text) => { seen.push(text); return "ок"; } },
  });
  await instance.handleUpdateForTest({ message: { chat: { id: 42 }, photo: [{ file_id: "p1" }], caption: "что это за брак?" } });
  assert.deepEqual(seen, ["что это за брак?"]);
  cleanup();
});

test("the transcriber sends the audio to the speech service with the shared secret", async () => {
  const seen = [];
  const transcriber = createVoiceTranscriber({
    speechUrl: "http://speech.test:4400",
    speechInternalSecret: "s3cret",
    fetch: async (url, options = {}) => {
      seen.push({ url, headers: options.headers, isForm: options.body instanceof FormData });
      if (url.includes("getFile")) return { ok: true, json: async () => ({ ok: true, result: { file_path: "voice/file_1.oga" } }) };
      if (url.includes("/file/bot")) return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
      return { ok: true, json: async () => ({ text: "  привет  " }) };
    },
  });

  assert.equal(await transcriber.transcribe("tok", "f1"), "привет");
  assert.match(seen[0].url, /bottok\/getFile$/);
  assert.match(seen[1].url, /\/file\/bottok\/voice\/file_1\.oga$/);
  assert.equal(seen[2].url, "http://speech.test:4400/stt");
  assert.equal(seen[2].headers["X-Speech-Secret"], "s3cret");
  assert.equal(seen[2].isForm, true);
});

test("an empty transcript is a failure, not an empty question to MILA", async () => {
  const transcriber = createVoiceTranscriber({
    fetch: async (url) => {
      if (url.includes("getFile")) return { ok: true, json: async () => ({ ok: true, result: { file_path: "v/f.oga" } }) };
      if (url.includes("/file/bot")) return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
      return { ok: true, json: async () => ({ text: "   " }) };
    },
  });
  await assert.rejects(transcriber.transcribe("tok", "f1"), /no text/);
});
