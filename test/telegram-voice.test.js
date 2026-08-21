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
import { audioFileId, createSpeaker, createVoiceTranscriber, spokenForm } from "../server/lib/telegram-voice.js";
import { speechInternalHeaders } from "../server/lib/speech-internal.js";

// What the speech container actually checks, read from the one definition
// rather than typed here: a test that repeats a guess only proves the guess
// is consistent with itself, which is how every voice note got a 401.
const SECRET_HEADER = Object.keys(speechInternalHeaders({}, "probe"))[0];

function bridge({ voice, assistant, speaker } = {}) {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-tgv-"));
  const file = path.join(dir, "links.json");
  fs.writeFileSync(file, JSON.stringify({ creator: { chatId: 42, linkedAt: "2026-08-01T00:00:00.000Z" } }));
  const instance = new TelegramBridge({
    file,
    integrations: () => ({ botToken: "test-token" }),
    fetch: async (url, options) => {
      // Text goes as JSON, audio as multipart: the stub has to survive both.
      const raw = options?.body;
      const body = raw instanceof FormData
        ? Object.fromEntries([...raw.keys()].map((key) => [key, raw.get(key)]))
        : JSON.parse(raw || "{}");
      calls.push({ method: url.split("/").pop(), body });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    },
    assistant: assistant || { respond: async (userId, text) => `эхо:${text}` },
    voice,
    speaker: speaker || { speak: async () => null },
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
  assert.equal(seen[2].headers[SECRET_HEADER], "s3cret");
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

test("starting the poller replaces the previous bot's command menu", async () => {
  const { instance, calls, cleanup } = bridge({ voice: { transcribe: async () => "unused" } });
  assert.equal(await instance.publishCommands(), true);
  const published = calls.find((call) => call.method === "setMyCommands");
  assert.deepEqual(published.body.commands.map((c) => c.command), ["help", "stop"]);
  cleanup();
});

test("a spoken question is answered out loud as well as in writing", async () => {
  const spoken = [];
  const { instance, calls, cleanup } = bridge({
    voice: { transcribe: async () => "сколько сшили вчера" },
    assistant: { respond: async () => "Вчера 6489 штук." },
    speaker: { speak: async (text) => { spoken.push(text); return Buffer.from([1, 2, 3]); } },
  });

  await instance.handleUpdateForTest({ message: voiceMessage });

  assert.deepEqual(spoken, ["Вчера 6489 штук."], "the answer is spoken, not the transcript");
  const methods = calls.map((call) => call.method);
  assert.ok(methods.includes("sendVoice"), "a voice message follows the text");
  // The text goes first and always: a voice message cannot be searched or quoted.
  assert.ok(methods.indexOf("sendMessage") < methods.indexOf("sendVoice"));
  cleanup();
});

test("a typed question is answered in writing only", async () => {
  const spoken = [];
  const { instance, calls, cleanup } = bridge({
    voice: { transcribe: async () => "unused" },
    assistant: { respond: async () => "Вчера 6489 штук." },
    speaker: { speak: async (text) => { spoken.push(text); return Buffer.from([1]); } },
  });

  await instance.handleUpdateForTest({ message: { chat: { id: 42 }, text: "сколько сшили вчера" } });

  assert.deepEqual(spoken, [], "nobody asked to be spoken to");
  assert.equal(calls.some((call) => call.method === "sendVoice"), false);
  cleanup();
});

test("speech that cannot be synthesised costs the voice, never the answer", async () => {
  const { instance, calls, cleanup } = bridge({
    voice: { transcribe: async () => "вопрос" },
    assistant: { respond: async () => "Ответ." },
    speaker: { speak: async () => { throw new Error("speech service down"); } },
  });

  await instance.handleUpdateForTest({ message: voiceMessage });

  const texts = calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);
  assert.ok(texts.includes("Ответ."), "the written answer survives a dead speech service");
  cleanup();
});

test("what gets spoken is prose, not markup", () => {
  const brief = "**План на 2026-08-21**\n\nПроизводство:\n• Швейка вчера: 6489 шт\n• За сроком: 35";
  const said = spokenForm(brief);
  assert.equal(/[*•#`]/.test(said), false, "asterisks and bullets read aloud are noise");
  assert.match(said, /План на 2026-08-21\. Производство:\. Швейка вчера: 6489 шт\. За сроком: 35/);
});

test("the speaker asks for the format Telegram can actually play", async () => {
  const seen = {};
  const speech = createSpeaker({
    speechUrl: "http://speech.test:4400",
    speechInternalSecret: "s3cret",
    fetch: async (url, options = {}) => {
      seen.url = url;
      seen.body = options.body?.toString();
      seen.headers = options.headers || {};
      return { ok: true, arrayBuffer: async () => new Uint8Array([9, 9]).buffer };
    },
  });

  const bytes = await speech.speak("Вчера 6489 штук.");
  assert.equal(bytes.length, 2);
  assert.equal(seen.url, "http://speech.test:4400/tts");
  assert.match(seen.body, /audio_format=opus/, "a WAV would arrive as a file, not as a voice message");
  assert.equal(seen.headers[SECRET_HEADER], "s3cret");
});

test("an answer too long to listen to stays written", async () => {
  const speech = createSpeaker({ fetch: async () => { throw new Error("must not be called"); } });
  assert.equal(await speech.speak("да ".repeat(900)), null);
  assert.equal(await speech.speak("   "), null);
});

test("the brief is read out only for the person who asked to hear it", async () => {
  const spoken = [];
  const { instance, calls, cleanup } = bridge({
    voice: { transcribe: async () => "unused" },
    speaker: { speak: async (text) => { spoken.push(text); return Buffer.from([7]); } },
  });

  assert.equal(await instance.sendSpoken("creator", "План на завтра"), true);
  assert.deepEqual(spoken, ["План на завтра"]);
  const methods = calls.map((call) => call.method);
  // Text first and always: audio cannot be searched or quoted.
  assert.ok(methods.indexOf("sendMessage") < methods.indexOf("sendVoice"));

  // Nobody linked: nothing is sent and nothing is synthesised.
  assert.equal(await instance.sendSpoken("usr_unlinked", "План"), false);
  assert.equal(spoken.length, 1);
  cleanup();
});

test("a silent speech service still delivers the brief", async () => {
  const { instance, calls, cleanup } = bridge({
    voice: { transcribe: async () => "unused" },
    speaker: { speak: async () => { throw new Error("speech down"); } },
  });

  assert.equal(await instance.sendSpoken("creator", "План на завтра"), false, "the voice failed");
  const texts = calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);
  assert.deepEqual(texts, ["План на завтра"], "the brief itself arrived");
  cleanup();
});

test("every text message offers to be read out", async () => {
  const { instance, calls, cleanup } = bridge({ voice: { transcribe: async () => "unused" } });
  await instance.sendText("creator", "План на завтра");
  const sent = calls.find((call) => call.method === "sendMessage");
  assert.deepEqual(
    sent.body.reply_markup.inline_keyboard[0][0],
    { text: "🔊 Озвучить", callback_data: "speak" },
  );
  cleanup();
});

test("tapping the button speaks the message it sits under", async () => {
  const spoken = [];
  const { instance, calls, cleanup } = bridge({
    voice: { transcribe: async () => "unused" },
    speaker: { speak: async (text) => { spoken.push(text); return Buffer.from([4, 2]); } },
  });

  await instance.handleUpdateForTest({
    callback_query: { id: "cb1", data: "speak", message: { chat: { id: 42 }, text: "Швейка вчера: 6489 шт" } },
  });

  // Telegram spins the button until it is answered, so that comes first.
  const methods = calls.map((call) => call.method);
  assert.ok(methods.indexOf("answerCallbackQuery") < methods.indexOf("sendVoice"));
  assert.deepEqual(spoken, ["Швейка вчера: 6489 шт"], "the text comes back with the press; nothing is stored");
  cleanup();
});

test("a stranger's button press reaches no service of ours", async () => {
  const spoken = [];
  const { instance, calls, cleanup } = bridge({
    voice: { transcribe: async () => "unused" },
    speaker: { speak: async (text) => { spoken.push(text); return Buffer.from([1]); } },
  });

  await instance.handleUpdateForTest({
    callback_query: { id: "cb2", data: "speak", message: { chat: { id: 999 }, text: "чужой чат" } },
  });

  assert.deepEqual(spoken, [], "an unlinked chat is a stranger here too");
  assert.equal(calls.some((call) => call.method === "sendVoice"), false);
  const answered = calls.find((call) => call.method === "answerCallbackQuery");
  assert.match(answered.body.text, /не привязан/);
  cleanup();
});

test("a message too long to listen to says so instead of going quiet", async () => {
  const { instance, calls, cleanup } = bridge({
    voice: { transcribe: async () => "unused" },
    speaker: { speak: async () => null },
  });

  await instance.handleUpdateForTest({
    callback_query: { id: "cb3", data: "speak", message: { chat: { id: 42 }, text: "очень длинный бриф" } },
  });

  const texts = calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);
  assert.match(texts.join(" "), /слишком длинное/);
  cleanup();
});

test("the voice asked for is the natural one, not the fast one", async () => {
  const seen = {};
  const speech = createSpeaker({
    fetch: async (url, options = {}) => {
      seen.body = options.body?.toString();
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
    },
  });
  await speech.speak("Швейка вчера: 6489 штук.");
  // "fast" is Piper, for live dialogue; a brief people actually listen to gets
  // the engine with prosody.
  assert.match(seen.body, /engine=quality/);
});
