import assert from "node:assert/strict";
import test from "node:test";

import { buildMilaSystemInstruction } from "../assets/js/mila-prompt.js";
import { MILA_MEMBER_TOOLS, MILA_TOOLS } from "../assets/js/mila-tools.js";

const names = (tools) => tools.map((tool) => tool.name);

test("she is never told she can read something she has no tool for", () => {
  // A Member gets the two read-only ERP tools, their own desk and the knowledge
  // base — no Kanban, no Obsidian, no Claude Workspace. The prompt claimed all
  // three anyway, two paragraphs above "these are the only tools you have on
  // this device". She would offer the lookup and then fail, or worse, not fail.
  const member = buildMilaSystemInstruction({ tools: names(MILA_MEMBER_TOOLS) });
  // Only the sentence that lists what she can read. Elsewhere the prompt warns
  // her not to confuse personal tasks with Kanban ones, which is a different
  // thing entirely and has to survive.
  const canRead = (prompt) => prompt.match(/You can read live Agentic OS state through your tools: [^.]+\./)?.[0] || "";
  assert.match(canRead(member), /Milana ERP business context/);
  for (const claim of ["Kanban", "Obsidian", "Claude Workspace"]) {
    assert.equal(canRead(member).includes(claim), false, `a Member has no tool for ${claim}`);
  }
  assert.equal(member.includes("Obsidian ERP wiki"), false, "nor the note it points at");
  assert.match(member, /separate from Kanban tasks/, "the warning not to confuse the two still applies");

  // An operator has all of them, and is still told so.
  const operator = buildMilaSystemInstruction({ tools: names(MILA_TOOLS) });
  for (const claim of ["Hermes and Kanban tasks", "the Obsidian library", "Claude Workspace sessions"]) {
    assert.ok(canRead(operator).includes(claim), `an operator does have ${claim}`);
  }
  // The list still reads as a sentence at both ends.
  assert.match(operator, /tools: Hermes and Kanban tasks, the Obsidian library, Claude Workspace sessions and Milana ERP business context\./);
  assert.match(member, /tools: Milana ERP business context\./);
});
