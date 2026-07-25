import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { composeAttachmentPrompt, attachmentDisplayText } from "../assets/js/mila-attachments.js";
import {
  buildAutomaticActivityDetection, buildLiveSetup, isAffectiveDialogRejection, isTranscriptPlausible,
  supportsAffectiveDialog,
} from "../assets/js/mila-live.js";
import {
  MILA_VOICES, MILA_VOICE_GROUPS, buildMilaSystemInstruction, normalizeMilaPreferences,
} from "../assets/js/mila-session.js";

test("Mila transcript filter rejects the wrong script for selected Russian", () => {
  assert.equal(isTranscriptPlausible("Как твои дела?", "ru-RU"), true);
  assert.equal(isTranscriptPlausible("आपने का मिला", "ru-RU"), false);
  assert.equal(isTranscriptPlausible("Agentic OS работает", "ru-RU"), true);
  assert.equal(isTranscriptPlausible("Agentic OS ishlayapti", "uz-UZ"), true);
});

test("Auto language still blocks scripts this workspace never speaks", () => {
  // Regression: auto used to wave every alphabet through, so Gemini rendering
  // Russian speech as Hindi reached the transcript and derailed the answer.
  assert.equal(isTranscriptPlausible("ऐसे बच्चे क्या करें? कई नालायक पेरेंट्स", "auto"), false);
  assert.equal(isTranscriptPlausible("مرحبا كيف حالك", "auto"), false);
  assert.equal(isTranscriptPlausible("你好我很好谢谢", "auto"), false);
  // The three languages the workspace actually speaks stay untouched.
  assert.equal(isTranscriptPlausible("Привет милая, как дела?", "auto"), true);
  assert.equal(isTranscriptPlausible("Salom, ishlar qalay?", "auto"), true);
  assert.equal(isTranscriptPlausible("Hey Mila, what is running right now?", "auto"), true);
  assert.equal(isTranscriptPlausible("Открой Kanban и покажи tasks", "auto"), true);
  // Cyrillic is wrong only when English was pinned explicitly.
  assert.equal(isTranscriptPlausible("Привет, как дела?", "en-US"), false);
  assert.equal(isTranscriptPlausible("Привет, как дела?", "ru-RU"), true);
  // Short or empty fragments are never judged.
  assert.equal(isTranscriptPlausible("", "auto"), true);
  assert.equal(isTranscriptPlausible("да", "auto"), true);
});

test("Mila Live setup uses a warm voice and explicit activity detection", () => {
  const setup = buildLiveSetup({ model: "gemini-live", systemInstruction: "Be helpful", listeningProfile: "noisy" });
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Sulafat");
  assert.equal(setup.realtimeInputConfig.activityHandling, "START_OF_ACTIVITY_INTERRUPTS");
  assert.deepEqual(setup.realtimeInputConfig.automaticActivityDetection, buildAutomaticActivityDetection("noisy"));
  assert.equal(setup.realtimeInputConfig.automaticActivityDetection.startOfSpeechSensitivity, "START_SENSITIVITY_LOW");
  assert.equal(setup.realtimeInputConfig.turnCoverage, "TURN_INCLUDES_ONLY_ACTIVITY");
  assert.deepEqual(setup.inputAudioTranscription, {});
  assert.deepEqual(setup.outputAudioTranscription, {});
});

test("Mila Live has Browser STT text fallback and a thinking timeout", () => {
  const source = fs.readFileSync(new URL("../assets/js/mila-live.js", import.meta.url), "utf8");
  const hub = fs.readFileSync(new URL("../assets/js/mila-session.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  assert.match(source, /BROWSER_STT_FALLBACK_MS/);
  assert.match(source, /THINKING_TIMEOUT_MS/);
  assert.match(source, /INPUT_ACTIVITY_LEVEL/);
  assert.match(source, /silenceTurnMs/);
  assert.match(source, /LIVEKIT_SDK_URL/);
  assert.match(source, /assets\/vendor\/livekit-client\.umd\.js/);
  assert.match(source, /liveKitClientGlobal/);
  assert.match(source, /_connectLiveKit/);
  assert.match(source, /new LK\.LocalAudioTrack\(/);
  assert.match(source, /publishTrack\(localTrack/);
  assert.doesNotMatch(source, /setMicrophoneEnabled\(true/);
  assert.match(source, /this\.usingLiveKit \|\| !Recognition/);
  assert.match(source, /inputDeviceId/);
  assert.match(api, /milaLiveKitToken/);
  assert.match(hub, /milaLiveKitToken/);
  assert.match(hub, /milaVoiceToken/);
  assert.match(source, /clientContent/);
  assert.match(source, /turnComplete: true/);
  assert.match(source, /finalChanged/);
  assert.match(source, /_trackInputActivity\(level\)/);
  assert.match(source, /_scheduleBrowserTextFallback\(this\.recognitionFinal\)/);
  assert.doesNotMatch(source, /realtimeInput: \{ text:/);
  assert.doesNotMatch(source, /userText && !this\.browserTranscription/);
  assert.match(source, /mergeTranscript\(this\.currentUser, userText\)/);
});

test("Mila preferences are validated and shape the voice behavior prompt", () => {
  const preferences = normalizeMilaPreferences({
    voiceName: "not-a-voice", style: "friend", pace: "slow", listeningProfile: "deliberate",
    responseLength: "brief", userName: " Бахадыр ", inputDeviceId: "windows-mic-1",
  });
  assert.equal(preferences.voiceName, "Sulafat");
  assert.equal(preferences.userName, "Бахадыр");
  assert.equal(preferences.inputDeviceId, "windows-mic-1");
  const prompt = buildMilaSystemInstruction({
    language: "ru-RU", preferences, currentTime: "2026-07-17T10:00:00.000Z",
  });
  assert.match(prompt, /live voice assistant/);
  assert.match(prompt, /Silently repair obvious speech-to-text mistakes/);
  assert.match(prompt, /changes settings, files, accounts, money, deployments/);
  assert.match(prompt, /ask for confirmation/);
  assert.match(prompt, /trusted, thoughtful friend/);
  assert.match(prompt, /one to three sentences/);
});

test("the full Gemini voice catalogue is exposed and every voice is groupable", () => {
  assert.equal(MILA_VOICES.length, 30, "Gemini Live ships 30 prebuilt voices");
  const ids = MILA_VOICES.map((voice) => voice.id);
  assert.equal(new Set(ids).size, 30, "voice ids must be unique");
  for (const id of ["Sulafat", "Kore", "Puck", "Charon", "Zephyr", "Enceladus"]) {
    assert.ok(ids.includes(id), `${id} should be selectable`);
  }
  const groups = new Set(MILA_VOICE_GROUPS.map((group) => group.id));
  for (const voice of MILA_VOICES) {
    assert.ok(groups.has(voice.group), `${voice.id} needs a known group`);
    assert.ok(voice.label && voice.description, `${voice.id} needs a label and description`);
  }
});

test("affective dialog rides generationConfig and only on models that take it", () => {
  // Probed against the live API: at setup top level every model answers
  // "unknown field"; inside generationConfig only native-audio models accept it,
  // and gemini-3.1-flash-live-preview fails the whole setup with 1011.
  assert.equal(supportsAffectiveDialog("gemini-2.5-flash-native-audio-latest"), true);
  assert.equal(supportsAffectiveDialog("gemini-2.5-flash-native-audio-preview-12-2025"), true);
  assert.equal(supportsAffectiveDialog("gemini-3.1-flash-live-preview"), false);
  assert.equal(supportsAffectiveDialog(""), false);

  const supported = buildLiveSetup({ model: "gemini-2.5-flash-native-audio-latest", voiceName: "Kore" });
  assert.equal(supported.generationConfig.enableAffectiveDialog, true);
  assert.equal("enableAffectiveDialog" in supported, false, "never at setup top level — that placement is rejected");
  assert.equal(supported.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");

  // A model that cannot take it must not receive it: the setup would be refused
  // and every call would pay a failed connection before the retry.
  const unsupported = buildLiveSetup({ model: "gemini-3.1-flash-live-preview" });
  assert.equal("enableAffectiveDialog" in unsupported.generationConfig, false);

  const off = buildLiveSetup({ model: "gemini-2.5-flash-native-audio-latest", affectiveDialog: false });
  assert.equal("enableAffectiveDialog" in off.generationConfig, false, "the field must be absent, not false");
});

test("only an affective-dialog rejection triggers the plain retry", () => {
  assert.equal(isAffectiveDialogRejection("Unknown field enableAffectiveDialog"), true);
  assert.equal(isAffectiveDialogRejection("enable_affective_dialog is not supported for this model"), true);
  assert.equal(isAffectiveDialogRejection("Quota exceeded"), false);
  assert.equal(isAffectiveDialogRejection("Mila Live disconnected"), false);
  assert.equal(isAffectiveDialogRejection(""), false);
  const source = fs.readFileSync(new URL("../assets/js/mila-live.js", import.meta.url), "utf8");
  assert.match(source, /affectiveDialog: false/, "the retry must drop the field");
});

test("delivery direction reaches the prompt without leaking stage directions", () => {
  const preferences = normalizeMilaPreferences({
    delivery: "quiet", voiceDirection: "  Speak   like a calm night-radio host  ", affectiveDialog: false,
  });
  assert.equal(preferences.delivery, "quiet");
  assert.equal(preferences.voiceDirection, "Speak like a calm night-radio host");
  assert.equal(preferences.affectiveDialog, false);
  assert.equal(normalizeMilaPreferences({ delivery: "nope" }).delivery, "natural");
  assert.equal(normalizeMilaPreferences({}).affectiveDialog, true);
  assert.equal(normalizeMilaPreferences({ voiceDirection: "x".repeat(500) }).voiceDirection.length, 240);

  const prompt = buildMilaSystemInstruction({ language: "ru-RU", preferences, currentTime: "2026-07-25T10:00:00.000Z" });
  assert.match(prompt, /Deliver lines softly and closely/);
  assert.match(prompt, /calm night-radio host/);
  assert.match(prompt, /\[whispers\]/);
  assert.match(prompt, /never pronounce the bracketed words/);
});

test("the live socket stays audio-only — live models cannot answer in text", () => {
  const setup = buildLiveSetup({ model: "gemini-live", systemInstruction: "Be helpful", tools: [{ name: "x" }] });
  assert.deepEqual(setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.ok(setup.generationConfig.speechConfig, "a call always needs a voice");
  assert.equal(setup.systemInstruction.parts[0].text, "Be helpful");
  assert.deepEqual(setup.tools, [{ functionDeclarations: [{ name: "x" }] }]);
});

test("writing goes to the Gemini chat endpoint, not the live socket", () => {
  const session = fs.readFileSync(new URL("../assets/js/mila-session.js", import.meta.url), "utf8");
  const apiClient = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../server/routes/integrations.js", import.meta.url), "utf8");
  const milaLib = fs.readFileSync(new URL("../server/lib/mila.js", import.meta.url), "utf8");

  // Sending text no longer demands an active call — only the mic toggle does.
  const sendTurnBody = /async sendTurn\(text, attachments = \[\]\) \{[\s\S]*?\n  \}/.exec(session)?.[0] || "";
  assert.ok(sendTurnBody, "sendTurn should still exist");
  assert.doesNotMatch(sendTurnBody, /Start a live call first/);
  assert.match(sendTurnBody, /this\.sendWritten\(text, attachments\)/);
  assert.match(session, /api\.integrations\.milaChat/);
  assert.match(session, /systemInstruction\("text"\)/);

  assert.match(apiClient, /\/api\/integrations\/mila\/chat/);
  assert.match(route, /\/mila\/chat/);
  assert.match(milaLib, /\/v1\/gemini\/chat/);
});

test("the chat route bounds history, image types and payload size", async () => {
  const route = fs.readFileSync(new URL("../server/routes/integrations.js", import.meta.url), "utf8");
  const limit = /const MAX_IMAGE_CHARS = ([^;]+);/.exec(route)[0];
  const source = /function chatMessages\(value\) \{[\s\S]*?\n\}/.exec(route)[0];
  const chatMessages = new Function(`${limit}\n${source.replace("function chatMessages", "return function chatMessages")}`)();

  const many = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `m${i}` }));
  assert.equal(chatMessages(many).length, 24, "only recent turns travel upstream");
  assert.equal(chatMessages(many)[0].content, "m16");

  const [message] = chatMessages([{
    role: "assistant",
    content: "x".repeat(40000),
    attachments: [
      { mimeType: "image/png", data: "ok" },
      { mimeType: "application/pdf", data: "nope" },
      { mimeType: "image/jpeg", data: "y".repeat(9 * 1024 * 1024) },
      { mimeType: "image/webp", data: "fine" },
      { mimeType: "image/png", data: "third" },
      { mimeType: "image/png", data: "fourth" },
      { mimeType: "image/png", data: "fifth" },
    ],
  }]);
  assert.equal(message.role, "assistant");
  assert.equal(message.content.length, 30000, "text is clamped");
  // Unsupported and oversize files are dropped first, so they cannot crowd out
  // real images; only then are the remaining images capped at four.
  assert.deepEqual(message.attachments.map((item) => item.data), ["ok", "fine", "third", "fourth"]);

  assert.deepEqual(chatMessages([{ role: "user", content: "   " }]), [], "empty turns are not sent");
  assert.deepEqual(chatMessages(undefined), []);
});

test("video rides the call and needs the direct connection", () => {
  const live = fs.readFileSync(new URL("../assets/js/mila-live.js", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../assets/js/pages/mila.js", import.meta.url), "utf8");
  const session = fs.readFileSync(new URL("../assets/js/mila-session.js", import.meta.url), "utf8");

  assert.match(live, /getDisplayMedia/);
  assert.match(live, /realtimeInput: \{ video:/);
  assert.match(live, /MAX_VIDEO_EDGE/);
  // The LiveKit agent has no video path, so the error says what to do about it.
  assert.match(live, /Video needs the direct connection/);
  assert.match(page, /shareVideo\("camera"\)/);
  assert.match(page, /shareVideo\("screen"\)/);
  assert.match(page, /milaDirectConnection/);
  assert.match(session, /directConnection/);
});

test("the written channel drops voice-only coaching from the prompt", () => {
  const preferences = normalizeMilaPreferences({ delivery: "quiet", voiceDirection: "night-radio host" });
  const args = { language: "ru-RU", preferences, currentTime: "2026-07-25T10:00:00.000Z" };
  const spoken = buildMilaSystemInstruction(args);
  const written = buildMilaSystemInstruction({ ...args, mode: "text" });

  assert.match(spoken, /\[whispers\]/);
  assert.match(spoken, /night-radio host/);
  assert.doesNotMatch(written, /\[whispers\]/, "stage directions are meaningless in writing");
  assert.doesNotMatch(written, /night-radio host/);
  assert.doesNotMatch(written, /Never read markdown/, "markdown is wanted in the chat");
  assert.match(written, /Markdown renders/);
  assert.match(written, /fenced code blocks/);
  // Shared identity, language rule and tool discipline survive in both.
  for (const prompt of [spoken, written]) {
    assert.match(prompt, /You are MILA/);
    assert.match(prompt, /Cyrillic rather than transliteration/);
    assert.match(prompt, /two-step confirmation/);
  }
});

test("Mila attachment prompt includes bounded text context and image names", () => {
  const attachments = [
    { kind: "image", name: "screen.png" },
    { kind: "text", name: "notes.md", content: "Release checklist", truncated: false },
  ];
  const prompt = composeAttachmentPrompt("Что здесь важно?", attachments, "ru-RU");
  assert.match(prompt, /Что здесь важно/);
  assert.match(prompt, /screen\.png/);
  assert.match(prompt, /Release checklist/);
  assert.equal(attachmentDisplayText("", attachments, "ru-RU"), "Прикреплено файлов: 2");
});

test("Mila workspace exposes language, attachment and transcript actions", () => {
  const source = fs.readFileSync(new URL("../assets/js/pages/mila.js", import.meta.url), "utf8");
  const hub = fs.readFileSync(new URL("../assets/js/mila-session.js", import.meta.url), "utf8");
  for (const id of ["milaLanguage", "milaPreferences", "milaInputDevice", "milaTestMicrophone", "milaAttach", "milaFile", "milaCopy", "milaExport", "milaDropOverlay"]) {
    assert.match(source, new RegExp(`id=\\"${id}\\"`));
  }
  assert.match(source, /prepareMilaAttachment/);
  assert.match(source, /Mila voice preferences/);
  for (const route of ["#\/workflows", "#\/knowledge", "#\/claude-code", "#\/hermes"]) assert.match(source, new RegExp(route));
  assert.match(hub, /transcriptionLanguage/);
  assert.match(hub, /inputDeviceId/);
  assert.match(source, /listMilaMicrophones/);
  assert.match(source, /testMilaMicrophone/);
});

test("Mila session persists across Agentic OS route unmounts", () => {
  const page = fs.readFileSync(new URL("../assets/js/pages/mila.js", import.meta.url), "utf8");
  const hub = fs.readFileSync(new URL("../assets/js/mila-session.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const unmount = page.slice(page.indexOf("unmount()"));
  assert.doesNotMatch(unmount, /\.stop\(/);
  assert.match(unmount, /unsubscribe/);
  assert.match(hub, /export const milaHub/);
  assert.match(app, /mountMilaDock\(\)/);
});

test("Mila mini chat exposes persistent call controls", () => {
  const source = fs.readFileSync(new URL("../assets/js/mila-dock.js", import.meta.url), "utf8");
  assert.match(source, /dock\.id = "milaDock"/);
  for (const id of ["milaDockText", "milaDockAttach", "milaDockMute", "milaDockEnd", "milaDockSend"]) {
    assert.match(source, new RegExp(`id=\\"${id}\\"`));
  }
  assert.match(source, /milaHub\.subscribe/);
  assert.match(source, /routeName\(\) === "mila"/);
});
