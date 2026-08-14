// /learn — "запомни, как мы это делаем" becomes a fleet skill.
//
// The operator describes a process — in chat, by voice, or by pasting a
// document — and MILA turns it into a SKILL.md in the house template: when to
// apply, steps, typical mistakes, how to verify. The skill lands in the Hermes
// catalog through the same bridge Skill Studio uses, so it is immediately
// visible and editable there.
//
// Teaching the fleet changes how every future task runs, so this is operator
// work behind the same two-step confirmation as the other writes: MILA shows
// what she is about to install, and installs only the confirmed version.
// Feedback is an update, not a duplicate: learning against an existing name
// rewrites that skill with the current content as context.

import { db } from "../store.js";
import { hermesSkillsRequest } from "./hermes-kanban.js";
import { milaGeminiChat } from "./mila.js";

const clean = (value, max) => String(value ?? "").trim().slice(0, max);

const LEARN_PROMPT = [
  "You turn an operator's description of a working procedure into a reusable skill document for an agent fleet.",
  "Reply with ONLY a JSON object, no prose, no code fences:",
  '{"name":"kebab-case-name","description":"...","category":"...","body":"# Title\\n\\n## Когда применять\\n...\\n\\n## Шаги\\n1. ...\\n\\n## Типовые ошибки\\n- ...\\n\\n## Как проверить\\n..."}',
  "Rules: name is kebab-case latin, max 60 chars, prefixed with the company product area when natural. description is a single line UNDER 60 characters. body is markdown in the language of the input, with exactly the four sections shown. Steps are imperative and concrete. Never include facts the operator did not state — an invented step is worse than a missing one. If the input mentions unverified company facts (составы тканей, размеры), the body must mark them ❔ rather than assert them.",
].join("\n");

export function createSkillLearner(options = {}) {
  const chat = options.chat || milaGeminiChat;
  const milaConfig = options.milaConfig || (() => db.integrations.byProvider("mila")?.config || {});
  const skillsRequest = options.skillsRequest || hermesSkillsRequest;

  function parseSkill(text) {
    const raw = clean(text, 30000).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const value = JSON.parse(raw);
    const name = clean(value.name, 60).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const description = clean(value.description, 60);
    const category = clean(value.category, 40) || "operations";
    const body = clean(value.body, 20000);
    if (name.length < 3) throw Object.assign(new Error("The skill needs a usable name"), { status: 502 });
    if (!description) throw Object.assign(new Error("The skill needs a one-line description"), { status: 502 });
    for (const section of ["## Когда применять", "## Шаги", "## Типовые ошибки", "## Как проверить"]) {
      if (!body.includes(section)) {
        throw Object.assign(new Error(`The generated skill is missing "${section}" — try describing the process again`), { status: 502 });
      }
    }
    return { name, description, category, body };
  }

  // Drafts the skill without installing anything: this is what the operator
  // confirms. The existing content, when the name is taken, becomes context so
  // feedback refines a skill instead of forking it.
  async function draft({ instruction, name = "", profile = "" }) {
    const source = clean(instruction, 20000);
    if (source.length < 30) {
      throw Object.assign(new Error("Describe the process in at least a sentence or two"), { status: 400 });
    }
    const cfg = milaConfig();
    if (!cfg.baseUrl) throw Object.assign(new Error("MILA backend is not configured"), { status: 503 });

    let existing = "";
    const requestedName = clean(name, 60);
    if (requestedName) {
      try {
        const current = await skillsRequest(`/api/skills/content?name=${encodeURIComponent(requestedName)}`);
        existing = clean(current?.content, 20000);
      } catch { /* new name — nothing to refine */ }
    }

    const result = await chat(cfg, "Skill learner", {
      messages: [{
        role: "user",
        content: existing
          ? `Существующий скилл "${requestedName}":\n${existing}\n\nОбратная связь оператора — обнови скилл с её учётом:\n${source}`
          : `Описание процесса от оператора${requestedName ? ` (название: ${requestedName})` : ""}:\n${source}`,
      }],
      systemPrompt: LEARN_PROMPT,
    });
    let parsed;
    try {
      parsed = parseSkill(result?.text);
    } catch (error) {
      if (error.status === 502) throw error;
      throw Object.assign(new Error("MILA could not structure this into a skill — try describing it step by step"), { status: 502 });
    }
    if (requestedName) parsed.name = requestedName.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    return { ...parsed, profile: clean(profile, 64), update: !!existing };
  }

  async function install(skill) {
    const front = `---\nname: ${skill.name}\ndescription: "${skill.description.replaceAll('"', "'")}"\nversion: 1.0.0\nauthor: MILA /learn\ncategory: ${skill.category}\n---\n\n`;
    const content = front + skill.body;
    if (skill.update) {
      return skillsRequest("/api/skills/content", {
        method: "PUT",
        body: { name: skill.name, content, profile: skill.profile || null },
      });
    }
    return skillsRequest("/api/skills", {
      method: "POST",
      body: { name: skill.name, content, category: skill.category, profile: skill.profile || null },
    });
  }

  return { draft, install };
}

export const skillLearner = createSkillLearner();
