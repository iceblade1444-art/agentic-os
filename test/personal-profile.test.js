import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PersonalProfileStore, PROFILE_CATEGORIES } from "../server/lib/personal-profile.js";
import { createMilaActions, PERSONAL_ACTIONS } from "../server/lib/mila-actions.js";
import { sharedAgentContext, CONTEXT_BUDGET } from "../server/lib/onboarding.js";
import { MILA_MEMBER_TOOLS, MILA_TOOLS } from "../assets/js/mila-tools.js";
import { buildMilaSystemInstruction } from "../assets/js/mila-prompt.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };
const OTHER = { id: "usr_2", name: "Shavkat", role: "Member" };

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-profile-"));
  return { dir, profiles: new PersonalProfileStore(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a profile belongs to one person and is invisible to anyone else", () => {
  const s = store();
  s.profiles.remember(OWNER.id, { fact: "С начальником швейного цеха говорить только по-узбекски", category: "people" });

  assert.equal(s.profiles.list(OWNER.id).length, 1);
  // Not filtered out for a colleague — genuinely absent from their store.
  assert.deepEqual(s.profiles.list(OTHER.id), []);
  assert.equal(s.profiles.contextBlock(OTHER.id), "");

  // On disk it is one file per account, named by hash: the folder does not even
  // reveal whose profiles exist.
  const files = fs.readdirSync(s.dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  assert.equal(files[0].includes(OWNER.id), false);
  s.cleanup();
});

test("it is never stored in the vault, where an operator could read it", () => {
  // The shared vault has no per-user scoping, so Agentic OS/People/<id>/SOUL.md
  // is readable by anyone holding the vault tools. That was fine for a timezone
  // and a job title; it is not fine for what this file now holds.
  const source = fs.readFileSync(new URL("../server/lib/personal-profile.js", import.meta.url), "utf8");
  // Comments explain the vault problem on purpose; it is the code that must not
  // touch it.
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.equal(code.includes("Agentic OS/People"), false);
  assert.equal(code.includes("obsidianVault"), false);
  assert.equal(/from "\.\/knowledge\.js"/.test(code), false, "the profile must not go through the vault library");
  assert.match(code, /personal-profiles/);
  assert.match(code, /mode: 0o600/);
});

test("the same fact said twice is remembered once", () => {
  const s = store();
  const first = s.profiles.remember(OWNER.id, { fact: "Не назначать встречи после 18:00" });
  const again = s.profiles.remember(OWNER.id, { fact: "не назначать встречи  ПОСЛЕ 18:00" });
  assert.equal(again.id, first.id);
  assert.equal(s.profiles.count(OWNER.id), 1);
  s.cleanup();
});

test("an empty or unknown-category fact is handled rather than lost", () => {
  const s = store();
  assert.throws(() => s.profiles.remember(OWNER.id, { fact: " " }), (error) => error.status === 400);
  // A category nobody recognises must not cost the owner the fact they just said.
  const fact = s.profiles.remember(OWNER.id, { fact: "Дочь родилась в марте", category: "выдуманная" });
  assert.equal(fact.category, "other");
  assert.ok(PROFILE_CATEGORIES.some((category) => category.id === fact.category));
  s.cleanup();
});

test("forgetting actually removes it", () => {
  const s = store();
  const fact = s.profiles.remember(OWNER.id, { fact: "Обедает в 13:00" });
  assert.equal(s.profiles.forget(OWNER.id, fact.id), true);
  assert.deepEqual(s.profiles.list(OWNER.id), []);
  assert.equal(s.profiles.forget(OWNER.id, fact.id), false, "forgetting twice is not an error to hide");
  s.cleanup();
});

test("the context block is bounded and newest first", () => {
  const s = store();
  for (let i = 0; i < 40; i += 1) s.profiles.remember(OWNER.id, { fact: `Факт номер ${i} ${"я".repeat(40)}` });
  const block = s.profiles.contextBlock(OWNER.id);
  assert.ok(block.length <= 600, `the profile must not crowd the context, got ${block.length}`);
  // Newest first, so a recent correction outranks an old fact when space runs
  // out. Facts dictated in one breath share a millisecond, so ordering cannot
  // rest on the clock — it rests on insertion order.
  assert.match(block.split("\n")[0], /Факт номер 39/);

  const corrected = store();
  corrected.profiles.remember(OWNER.id, { fact: "Звонить после десяти" });
  corrected.profiles.remember(OWNER.id, { fact: "Нет, звонить после одиннадцати" });
  assert.match(corrected.profiles.list(OWNER.id)[0].text, /одиннадцати/);
  corrected.cleanup();
  s.cleanup();
});

test("the profile reaches the owner's agent context and nobody else's", () => {
  const s = store();
  s.profiles.remember(OWNER.id, { fact: "Звонить только после десяти утра" });
  const state = {
    workspace: { completedAt: "2026-01-01T00:00:00.000Z", name: "Milana Premium" },
    profile: { timezone: "Asia/Tashkent" },
  };
  const options = { vault: os.tmpdir(), journal: { recentText: () => "" }, profiles: s.profiles };

  const mine = sharedAgentContext(OWNER, state, options);
  assert.match(mine, /Звонить только после десяти утра/);
  assert.match(mine, /has told you about themselves/);
  assert.ok(mine.length <= CONTEXT_BUDGET);

  const theirs = sharedAgentContext(OTHER, state, options);
  assert.equal(theirs.includes("Звонить только после десяти утра"), false);
  s.cleanup();
});

test("MILA can remember, read and forget — on her own account only", async () => {
  const s = store();
  const actions = createMilaActions({
    personalProfiles: s.profiles,
    journal: { append: async () => null, recentText: () => "" },
    onboarding: { get: () => ({ profile: {} }) },
    db: { mcp: { list: () => [], update: () => {} } },
  });

  const saved = await actions.call("remember_about_me", {
    fact: "С Шавкатом обсуждать отгрузки только письменно", category: "people",
  }, { actor: OWNER.name, user: OWNER });
  assert.equal(saved.ok, true);
  assert.match(saved.note, /Виден только вам/);

  const read = await actions.call("read_about_me", {}, { actor: OWNER.name, user: OWNER });
  assert.equal(read.facts.length, 1);
  assert.match(read.source_policy, /never repeat it to anyone else/);

  // A colleague's agent sees an empty profile, not this one.
  const other = await actions.call("read_about_me", {}, { actor: OTHER.name, user: OTHER });
  assert.deepEqual(other.facts, []);

  await actions.call("forget_about_me", { factId: saved.fact.id }, { actor: OWNER.name, user: OWNER });
  assert.equal(s.profiles.count(OWNER.id), 0);
  await assert.rejects(
    actions.call("forget_about_me", { factId: saved.fact.id }, { actor: OWNER.name, user: OWNER }),
    (error) => error.status === 404,
  );
  s.cleanup();
});

test("the private fact never lands in the shared journal", async () => {
  const s = store();
  const journalled = [];
  const actions = createMilaActions({
    personalProfiles: s.profiles,
    journal: { append: async (entry) => { journalled.push(entry); return entry; }, recentText: () => "" },
    onboarding: { get: () => ({ profile: {} }) },
    db: { mcp: { list: () => [], update: () => {} } },
  });
  await actions.call("remember_about_me", { fact: "Дочь родилась в марте" }, { actor: OWNER.name, user: OWNER });

  // The journal is read by every agent that asks for workspace context, so it
  // records that the profile changed — never what was written into it.
  assert.equal(journalled.length, 1);
  assert.equal(journalled[0].title.includes("Дочь"), false);
  assert.match(journalled[0].title, /личный профиль/i);
  s.cleanup();
});

test("everyone gets the profile tools, and the prompt forbids inventing facts", () => {
  for (const name of ["remember_about_me", "read_about_me", "forget_about_me"]) {
    assert.ok(PERSONAL_ACTIONS.has(name), `${name} must be scoped to the caller's own account`);
    assert.ok(MILA_TOOLS.some((tool) => tool.name === name));
    // It is their own private profile, so an employee keeps one too.
    assert.ok(MILA_MEMBER_TOOLS.some((tool) => tool.name === name));
  }

  const prompt = buildMilaSystemInstruction({ tools: ["get_my_day_plan", "remember_about_me", "read_about_me"] });
  assert.match(prompt, /Record only what they actually said or confirmed/);
  assert.match(prompt, /never write down a conclusion you drew from their behaviour|Never write down a conclusion/i);
  assert.match(prompt, /never repeat any of it to a colleague/);

  // A surface without the tool is not told it keeps a profile.
  const without = buildMilaSystemInstruction({ tools: ["get_my_day_plan"] });
  assert.equal(without.includes("remember_about_me"), false);
});

test("deleting the account takes the profile with it", () => {
  const source = fs.readFileSync(new URL("../server/lib/account-lifecycle.js", import.meta.url), "utf8");
  assert.match(source, /profileStore\.clear\(id\)/);
});
