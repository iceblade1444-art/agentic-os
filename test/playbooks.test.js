import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AGENT_PLAYBOOKS, readAgentPlaybook, sharedAgentContext } from "../server/lib/onboarding.js";

function vaultWith(t, contents = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-playbook-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, body] of Object.entries(contents)) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
  }
  return dir;
}

const entry = AGENT_PLAYBOOKS[0];

test("a playbook is read from the vault without its front matter", (t) => {
  const vault = vaultWith(t, {
    [entry.file]: "---\ntype: agentic-os-playbook\n---\n\n# Marketing\n\n- Tone: warm, no hype\n",
  });
  const body = readAgentPlaybook(entry, 6000, vault);
  assert.match(body, /# Marketing/);
  assert.match(body, /Tone: warm, no hype/);
  assert.doesNotMatch(body, /type: agentic-os-playbook/, "front matter is Obsidian bookkeeping, not context");
});

test("a missing, oversized or out-of-vault playbook is simply absent", (t) => {
  const vault = vaultWith(t, { [entry.file]: "x".repeat(300 * 1024) });
  assert.equal(readAgentPlaybook(entry, 6000, vault), "", "an oversized note is skipped, not truncated in");
  assert.equal(readAgentPlaybook(entry, 6000, vaultWith(t)), "", "no note means no context");
  // A mis-edited entry must not read outside the vault.
  assert.equal(readAgentPlaybook({ file: "../../../etc/passwd" }, 6000, vault), "");
  assert.equal(readAgentPlaybook({ file: "../secrets.md" }, 6000, vault), "");
});

test("the playbook takes only the room left, never the facts above it", (t) => {
  const vault = vaultWith(t, { [entry.file]: `# Playbook\n${"tone rules. ".repeat(2000)}` });
  const state = {
    workspace: {
      completedAt: Date.now(), name: "Milana Premium", industry: "textile",
      summary: "Sleepwear manufacturer", audience: "wholesale buyers",
      products: "sleepwear", goals: ["grow sales"], constraints: ["ask before external messages"],
      operatingLanguages: ["Russian"],
    },
    profile: { locale: "ru-RU", timezone: "Asia/Tashkent", roleFocus: "owner" },
  };
  const user = { id: "creator", name: "Bakhadyr", role: "Creator" };

  const withPlaybook = sharedAgentContext(user, state, { vault });
  const withoutPlaybook = sharedAgentContext(user, state, { vault: vaultWith(t) });

  assert.ok(withPlaybook.length <= 6000, "consumers clamp at 6000, so this must fit");
  assert.match(withPlaybook, /Marketing and content playbook \(authoritative/);
  // Everything that was there before the playbook survives it.
  for (const fact of ["Workspace: Milana Premium", "Sleepwear manufacturer", "Current user: Bakhadyr", "User work focus: owner"]) {
    assert.ok(withPlaybook.includes(fact), `${fact} must not be pushed out`);
    assert.ok(withoutPlaybook.includes(fact));
  }
  assert.ok(withPlaybook.length > withoutPlaybook.length, "the playbook should actually add something");
});

test("the playbook stays behind the same gate as the workspace context", (t) => {
  const vault = vaultWith(t, { [entry.file]: "# Playbook\n- Tone: warm\n" });
  const state = { workspace: { completedAt: Date.now(), name: "Milana Premium" }, profile: {} };
  const viewer = sharedAgentContext({ id: "v", name: "Viewer", role: "Viewer" }, state, { vault });
  assert.doesNotMatch(viewer, /Tone: warm/, "business context is Creator/Admin only");
  // An unfinished workspace has no authoritative context to attach a playbook to.
  const pending = sharedAgentContext({ id: "creator", name: "B", role: "Creator" }, { workspace: {}, profile: {} }, { vault });
  assert.doesNotMatch(pending, /Tone: warm/);
});

test("the shipped template asks real questions and states the hard rules", () => {
  const template = fs.readFileSync(new URL("../docs/playbooks/marketing-playbook.template.md", import.meta.url), "utf8");
  // Placeholders are the point: an unanswered question must look unanswered.
  assert.ok((template.match(/<\?>/g) || []).length >= 20, "the template should ask plenty");
  for (const section of ["Кому продаём", "Голос бренда", "Каналы", "Сезонность", "Конкуренты", "Жёсткие правила", "Что уже пробовали"]) {
    assert.ok(template.includes(section), `${section} should be covered`);
  }
  assert.match(template, /без подтверждения человеком/, "publishing stays gated");
  assert.match(template, /Не выдумывать цифры/, "no invented facts");
});

