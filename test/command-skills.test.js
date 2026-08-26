// The skills deck (Ф6): cards are real Hermes skills, ▶ is a real run. What
// these defend: the run path uses only fields the kanban route accepts, the
// spend is confirmed before it happens, and a silent runtime reads as an
// honest state instead of an empty deck.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const COMMAND = read("assets/js/pages/command.js");

test("the deck is the real skill registry, not a hardcoded list", () => {
  assert.match(COMMAND, /api\.skills\.list\(\)/);
  // Silence from the runtime is a stated state…
  assert.match(COMMAND, /skills === null \? `<div class="cmd-empty">\$\{t\("dash\.svc\.unreachable"\)\}/);
  // …and an empty registry is a different one.
  assert.match(COMMAND, /t\("cmd\.noSkills"\)/);
});

test("▶ creates a task the kanban route will actually accept", () => {
  // The route bounds title/assignee/initialStatus; "ready" is in its allowed
  // set and "default" passes its profile pattern — checked against the source
  // so a route change breaks this test, not the button.
  const route = read("server/routes/kanban.js");
  assert.match(route, /\["triage", "todo", "ready"\]\.includes\(initialStatus\)/);
  assert.match(COMMAND, /api\.kanban\.createTask\(\{\s*title: `\/\$\{name\}`,/);
  assert.match(COMMAND, /initialStatus: "ready"/);
  assert.match(COMMAND, /assignee: "default"/);
});

test("running a skill is confirmed before it spends agent time", () => {
  const run = COMMAND.slice(COMMAND.indexOf("function runSkill"), COMMAND.indexOf("const SKILL_ICONS"));
  assert.ok(run.includes("confirmDialog("), "the ▶ must ask first");
  assert.ok(run.indexOf("confirmDialog(") < run.indexOf("api.kanban.createTask"),
    "the confirm has to come before the create");
});

test("a disabled skill cannot be run from the deck", () => {
  assert.match(COMMAND, /data-run-skill="\$\{esc\(skill\.name\)\}"[^>]*\$\{skill\.enabled && api\.auth\.canWrite \? "" : "disabled"\}/);
});
