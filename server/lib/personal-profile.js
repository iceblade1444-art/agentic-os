// What MILA knows about the person she works for.
//
// Two decisions shape this file, both deliberate.
//
// It is stored per user outside the vault. `Agentic OS/People/<id>/SOUL.md` sits
// in the shared vault, and the vault has no per-user scoping — an operator with
// the vault tools can read anyone's page. That was harmless while it held a
// timezone and a job title; it is not harmless for "his daughter's birthday is
// in March". Isolation here comes from the storage layout, not from a promise.
//
// And she only records what she was told. An assistant that infers — "he always
// moves meetings to the morning" — writes its own conclusions down as fact, and
// a wrong one then colours every later answer with no way for the person to see
// why. Everything in here traces back to a sentence the owner said.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";

// Categories exist so the profile can be read back grouped and trimmed by
// relevance rather than by luck. Anything unrecognised lands in "other" instead
// of being refused: losing a fact the owner just dictated is the worse failure.
export const PROFILE_CATEGORIES = [
  { id: "people", label: "Люди вокруг", hint: "коллеги, партнёры, как с кем общаться" },
  { id: "preferences", label: "Предпочтения", hint: "как удобно работать, чего избегать" },
  { id: "commitments", label: "Обязательства", hint: "регулярные встречи, обещания, привычный распорядок" },
  { id: "dates", label: "Важные даты", hint: "дни рождения, годовщины, сроки" },
  { id: "other", label: "Прочее", hint: "всё остальное" },
];
const CATEGORY_IDS = new Set(PROFILE_CATEGORIES.map((category) => category.id));

const MAX_FACT = 400;
const MAX_FACTS = 300;
const CONTEXT_BUDGET = 600;

const now = () => new Date().toISOString();
const clean = (value, max) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);

export class PersonalProfileStore {
  constructor(baseDir = path.join(path.resolve(config.dataDir), "personal-profiles")) {
    this.baseDir = baseDir;
  }

  #file(userId) {
    const key = crypto.createHash("sha256").update(String(userId || "")).digest("hex");
    return path.join(this.baseDir, `${key}.json`);
  }

  #read(userId) {
    try {
      const value = JSON.parse(fs.readFileSync(this.#file(userId), "utf8"));
      return Array.isArray(value.facts) ? value.facts : [];
    } catch {
      return [];
    }
  }

  #write(userId, facts) {
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    const file = this.#file(userId);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, facts: facts.slice(-MAX_FACTS) }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    hardenRuntimeFile(file, 0o600);
  }

  // Ordered by insertion, not by clock. Several facts dictated in one breath
  // share a millisecond, and a timestamp sort would then order them at random —
  // which decides which ones survive the context budget. A correction said after
  // a mistake has to outrank it, every time.
  list(userId, { category = "" } = {}) {
    const facts = this.#read(userId);
    const wanted = clean(category, 40);
    return (wanted ? facts.filter((fact) => fact.category === wanted) : facts)
      .slice()
      .sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0)
        || String(b.addedAt).localeCompare(String(a.addedAt)));
  }

  remember(userId, input = {}) {
    const text = clean(input.fact, MAX_FACT);
    if (text.length < 3) throw Object.assign(new Error("There is nothing to remember"), { status: 400 });
    const facts = this.#read(userId);
    // The same sentence said twice is one fact, not two.
    const existing = facts.find((fact) => fact.text.toLowerCase() === text.toLowerCase());
    if (existing) return existing;
    const fact = {
      id: `fct_${crypto.randomUUID()}`,
      category: CATEGORY_IDS.has(input.category) ? input.category : "other",
      text,
      seq: facts.reduce((highest, item) => Math.max(highest, Number(item.seq) || 0), 0) + 1,
      addedAt: now(),
    };
    facts.push(fact);
    this.#write(userId, facts);
    return fact;
  }

  forget(userId, factId) {
    const facts = this.#read(userId);
    const next = facts.filter((fact) => fact.id !== factId);
    if (next.length === facts.length) return false;
    this.#write(userId, next);
    return true;
  }

  clear(userId) {
    fs.rmSync(this.#file(userId), { force: true });
    return true;
  }

  /// The slice that travels in the prompt. The rest is retrieved on demand, for
  /// the same reason the company knowledge is: the shared context is 9000
  /// characters and mostly spoken for.
  contextBlock(userId, budget = CONTEXT_BUDGET) {
    const facts = this.list(userId);
    if (!facts.length) return "";
    const lines = [];
    let used = 0;
    for (const fact of facts) {
      const line = `- ${fact.text}`;
      if (used + line.length + 1 > budget) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join("\n");
  }

  count(userId) {
    return this.#read(userId).length;
  }
}

export const personalProfiles = new PersonalProfileStore();
