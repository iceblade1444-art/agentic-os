import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { composeAttachmentPrompt, attachmentDisplayText } from "../assets/js/mila-attachments.js";
import { isTranscriptPlausible } from "../assets/js/mila-live.js";

test("Mila transcript filter rejects the wrong script for selected Russian", () => {
  assert.equal(isTranscriptPlausible("Как твои дела?", "ru-RU"), true);
  assert.equal(isTranscriptPlausible("आपने का मिला", "ru-RU"), false);
  assert.equal(isTranscriptPlausible("Agentic OS работает", "ru-RU"), true);
  assert.equal(isTranscriptPlausible("Agentic OS ishlayapti", "uz-UZ"), true);
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
  for (const id of ["milaLanguage", "milaAttach", "milaFile", "milaCopy", "milaExport", "milaDropOverlay"]) {
    assert.match(source, new RegExp(`id=\\"${id}\\"`));
  }
  assert.match(source, /prepareMilaAttachment/);
  assert.match(hub, /transcriptionLanguage/);
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
