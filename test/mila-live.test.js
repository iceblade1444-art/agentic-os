import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { composeAttachmentPrompt, attachmentDisplayText } from "../assets/js/mila-attachments.js";
import { buildAutomaticActivityDetection, buildLiveSetup, isTranscriptPlausible } from "../assets/js/mila-live.js";
import { buildMilaSystemInstruction, normalizeMilaPreferences } from "../assets/js/mila-session.js";

test("Mila transcript filter rejects the wrong script for selected Russian", () => {
  assert.equal(isTranscriptPlausible("Как твои дела?", "ru-RU"), true);
  assert.equal(isTranscriptPlausible("आपने का मिला", "ru-RU"), false);
  assert.equal(isTranscriptPlausible("Agentic OS работает", "ru-RU"), true);
  assert.equal(isTranscriptPlausible("Agentic OS ishlayapti", "uz-UZ"), true);
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
  assert.match(source, /setMicrophoneEnabled\(true, this\._microphoneConstraints\(\)\)/);
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
