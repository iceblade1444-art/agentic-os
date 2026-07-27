import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { getLocale, localizedDate, setLocale, t } from "../assets/js/i18n.js";
import { timeAgo } from "../assets/js/store.js";

const sourceKeys = (source, fn) => [
  ...source.matchAll(new RegExp(`\\b${fn}\\(\\s*"((?:personal|shell|login|nav|system|memory|guardrails|secrets|evaluations)\\.[^"]+)"`, "g")),
].map((match) => match[1]);

test("interface dictionary provides RU, EN and UZ copy for localized product surfaces", () => {
  const personal = fs.readFileSync(new URL("../assets/js/pages/personal.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const misc = fs.readFileSync(new URL("../assets/js/pages/misc.js", import.meta.url), "utf8");
  const dynamicKeys = [
    "personal.tab.today", "personal.tab.soul", "personal.tab.memory", "personal.tab.approvals",
    "personal.tab.account", "personal.greeting.night", "personal.greeting.morning",
    "personal.greeting.day", "personal.greeting.evening", "personal.style.assistant",
    "personal.style.friend", "personal.style.operator", "personal.style.mentor",
    "personal.status.connected", "personal.status.setup", "personal.status.disconnected",
    "personal.task.doing", "personal.task.todo", "personal.approved", "personal.rejected",
    "personal.noAgentRequests", "personal.operatorOnly", "personal.noDecisions", "personal.memberSafe",
    "shell.newKanbanTask", "shell.newPersonalTask",
  ];
  const keys = new Set([...sourceKeys(personal, "t"), ...sourceKeys(app, "tr"), ...sourceKeys(misc, "t"), ...dynamicKeys]);

  for (const locale of ["ru-RU", "en-US", "uz-UZ"]) {
    setLocale(locale, false);
    for (const key of keys) assert.notEqual(t(key), key, `${locale} is missing ${key}`);
  }
});

test("locale changes text interpolation and date formatting without browser globals", () => {
  setLocale("en-US", false);
  assert.equal(getLocale(), "en-US");
  assert.equal(t("personal.waitingCount", { count: 3 }), "3 waiting");
  assert.match(localizedDate("2026-07-25T12:00:00Z"), /Jul/);

  setLocale("uz-UZ", false);
  assert.equal(t("personal.title"), "Shaxsiy");
  assert.equal(t("memory.scope.workspace"), "ish maydoni");
  assert.doesNotMatch(timeAgo(Date.now() - 4 * 86400000), /ago/);

  setLocale("ru-RU", false);
  assert.match(timeAgo(Date.now() - 4 * 86400000), /дн/);
});

test("language selectors persist through the authenticated onboarding profile", () => {
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const helper = fs.readFileSync(new URL("../assets/js/profile-locale.js", import.meta.url), "utf8");
  assert.match(app, /id="interfaceLocale"/);
  assert.match(app, /id="loginLocale"/);
  assert.match(app, /saveProfileLocale\(language\.value\)/);
  assert.match(helper, /api\.onboarding\.save/);
  assert.match(helper, /current\.canEditWorkspace/);
  assert.match(helper, /milaHub\.setLanguage/);
});
