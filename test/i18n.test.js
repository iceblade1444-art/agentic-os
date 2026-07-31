import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { getLocale, localizedDate, setLocale, t } from "../assets/js/i18n.js";
import { timeAgo } from "../assets/js/store.js";

const sourceKeys = (source, fn) => [
  ...source.matchAll(new RegExp(`\\b${fn}\\(\\s*"((?:personal|shell|login|nav|system|memory|guardrails|secrets|evaluations|member|settings|kanban|operations|mcp|integrations|studio)\\.[^"]+)"`, "g")),
].map((match) => match[1]);

test("interface dictionary provides RU, EN and UZ copy for localized product surfaces", () => {
  const personal = fs.readFileSync(new URL("../assets/js/pages/personal.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const misc = fs.readFileSync(new URL("../assets/js/pages/misc.js", import.meta.url), "utf8");
  const member = fs.readFileSync(new URL("../assets/js/pages/member.js", import.meta.url), "utf8");
  const settings = fs.readFileSync(new URL("../assets/js/pages/settings.js", import.meta.url), "utf8");
  const kanban = fs.readFileSync(new URL("../assets/js/pages/workflows.js", import.meta.url), "utf8");
  const studio = fs.readFileSync(new URL("../assets/js/pages/studio.js", import.meta.url), "utf8");
  const dynamicKeys = [
    "personal.tab.today", "personal.tab.soul", "personal.tab.memory", "personal.tab.approvals",
    "personal.tab.account", "personal.greeting.night", "personal.greeting.morning",
    "personal.greeting.day", "personal.greeting.evening", "personal.style.assistant",
    "personal.style.friend", "personal.style.operator", "personal.style.mentor",
    "personal.status.connected", "personal.status.setup", "personal.status.disconnected",
    "personal.task.doing", "personal.task.todo", "personal.approved", "personal.rejected",
    "personal.noAgentRequests", "personal.operatorOnly", "personal.noDecisions", "personal.memberSafe",
    "shell.newKanbanTask", "shell.newPersonalTask",
    ...["normal", "high", "urgent", "critical"].map((value) => `kanban.priority.${value}`),
    ...["triage", "todo", "scheduled", "ready", "running", "review", "blocked", "done", "archived"].map((value) => `kanban.status.${value}`),
    ...["orchestrator", "research", "writing", "growth", "engineering", "specialist"].map((value) => `kanban.role.${value}`),
    ...["working", "waiting", "queued"].map((value) => `kanban.agent.${value}`),
    ...["healthy", "degraded", "critical", "success", "running", "error", "unknown"].map((value) => `operations.status.${value}`),
    ...["planning", "research", "design", "sampling", "approved", "production", "released", "archived"].map((value) => `studio.collection.status.${value}`),
    ...["idea", "research", "sketch", "technical", "sample", "review", "approved", "production", "released", "rejected"].map((value) => `studio.model.status.${value}`),
    ...["brief", "concept", "production", "review", "scheduled", "live", "measuring", "complete", "cancelled"].map((value) => `studio.campaign.status.${value}`),
    ...["draft", "queued", "running", "review", "complete", "failed", "cancelled"].map((value) => `studio.job.status.${value}`),
    ...["trend", "competitor", "mass_market", "sales", "customer"].flatMap((value) => [`studio.analytics.type.${value}`, `studio.analytics.type.${value}.hint`]),
    ...["increase", "maintain", "reduce", "stop", "validate"].map((value) => `studio.analytics.action.${value}`),
  ];
  const keys = new Set([
    ...sourceKeys(personal, "t"), ...sourceKeys(app, "tr"), ...sourceKeys(misc, "t"),
    ...sourceKeys(member, "t"), ...sourceKeys(settings, "t"), ...sourceKeys(kanban, "t"),
    ...sourceKeys(studio, "t"), ...dynamicKeys,
  ]);

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
