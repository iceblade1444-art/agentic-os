import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { OnboardingStore, onboardingContextDocuments } from "../server/lib/onboarding.js";

function temporaryStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-onboarding-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "onboarding.json");
  return { store: new OnboardingStore(file), file };
}

const creator = { id: "creator", name: "Creator", role: "Creator" };

test("onboarding persists bounded user and workspace context", (t) => {
  const { store, file } = temporaryStore(t);
  const state = store.update(creator, {
    profile: { locale: "ru-RU", timezone: "Asia/Tashkent", roleFocus: "Owner", assistantStyle: "operator", responseLength: "brief" },
    workspace: {
      name: "Milana Premium", industry: "Retail", summary: "Customer commerce platform",
      audience: "Retail customers", products: "Fashion and services",
      goals: ["Launch Agentic OS", "Launch Agentic OS", "Automate operations"],
      constraints: ["Confirm external actions"], operatingLanguages: ["Russian", "Uzbek", "Unknown"],
    },
  });

  assert.equal(state.needsOnboarding, false);
  assert.deepEqual(state.workspace.goals, ["Launch Agentic OS", "Automate operations"]);
  assert.deepEqual(state.workspace.operatingLanguages, ["Russian", "Uzbek"]);
  assert.equal(state.profile.assistantStyle, "operator");
  assert.equal(new OnboardingStore(file).get(creator).needsOnboarding, false);
});

test("members cannot overwrite completed shared business context", (t) => {
  const { store } = temporaryStore(t);
  const base = {
    profile: { locale: "en-US" },
    workspace: { name: "Owner Workspace", goals: ["Keep this goal"] },
  };
  store.update(creator, base);
  const member = { id: "usr_member", name: "Member", role: "Member" };
  const state = store.update(member, {
    profile: { locale: "uz-UZ", assistantStyle: "friend" },
    workspace: { name: "Overwritten Workspace", goals: ["Wrong goal"] },
  });
  assert.equal(state.workspace.name, "Owner Workspace");
  assert.deepEqual(state.workspace.goals, ["Keep this goal"]);
  assert.equal(state.profile.locale, "uz-UZ");
});

test("onboarding produces shared Obsidian context without secrets", (t) => {
  const { store } = temporaryStore(t);
  const state = store.update(creator, {
    profile: { locale: "ru-RU", roleFocus: "Owner", assistantStyle: "assistant" },
    workspace: { name: "Milana Premium", goals: ["Improve operations"], constraints: ["Approval before publishing"] },
  });
  const documents = onboardingContextDocuments(creator, state);
  assert.deepEqual(documents.map((item) => item.path), ["Agentic OS/Workspace Context.md", "Agentic OS/People/creator.md"]);
  assert.match(documents[0].content, /Improve operations/);
  assert.doesNotMatch(JSON.stringify(documents), /password|api[_ -]?key/i);
});

test("frontend gates the shell on server onboarding and exposes settings entry", () => {
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const settings = fs.readFileSync(new URL("../assets/js/pages/settings.js", import.meta.url), "utf8");
  assert.match(app, /onboarding\.needsOnboarding/);
  assert.match(api, /\/api\/onboarding/);
  assert.match(settings, /Review workspace setup/);
});
