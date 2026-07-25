import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { composeAttachmentPrompt, attachmentDisplayText } from "../assets/js/mila-attachments.js";
import {
  buildAutomaticActivityDetection, buildLiveSetup, isAffectiveDialogRejection, isTranscriptPlausible,
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

test("affective dialog is requested by default and can be turned off", () => {
  const on = buildLiveSetup({ model: "gemini-live", voiceName: "Kore" });
  assert.equal(on.enableAffectiveDialog, true);
  assert.equal(on.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
  const off = buildLiveSetup({ model: "gemini-live", affectiveDialog: false });
  assert.equal("enableAffectiveDialog" in off, false, "the field must be absent, not false");
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
