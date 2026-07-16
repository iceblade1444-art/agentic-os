import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Hermes fleet ships four persistent specialist identities", () => {
  for (const role of ["scout", "scribe", "reach", "dev"]) {
    const soul = fs.readFileSync(path.join(root, "hermes", "fleet", role, "SOUL.md"), "utf8");
    const agents = fs.readFileSync(path.join(root, "hermes", "fleet", role, "AGENTS.md"), "utf8");
    assert.match(soul, new RegExp(`^# ${role}`, "im"));
    assert.match(agents, /Kanban/i);
    assert.match(agents, /Obsidian/i);
  }
});

test("Hermes fleet installer keeps Telegram on the orchestrator only", () => {
  const script = fs.readFileSync(path.join(root, "scripts", "configure-hermes-fleet.sh"), "utf8");
  assert.match(script, /profile create.*--clone-from default/);
  assert.match(script, /"TELEGRAM_BOT_TOKEN": ""/);
  assert.match(script, /enable_platform_toolset "\$HOME\/\.hermes\/config\.yaml" telegram kanban/);
  assert.match(script, /set_profile_toolsets "\$HOME\/\.hermes\/config\.yaml" hermes-cli kanban/);
  assert.match(script, /set_profile_toolsets "\$profile_home\/config\.yaml" hermes-cli/);
  assert.match(script, /kanban\.max_in_progress 2/);
  assert.match(script, /state-snapshots/);
  assert.doesNotMatch(script, /-p "\$name" gateway start/);
});
