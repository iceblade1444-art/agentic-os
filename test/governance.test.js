import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { activeGuardrails, GovernanceStore } from "../server/lib/governance.js";

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-governance-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "governance.json");
  return { store: new GovernanceStore(file), file };
}

test("secret vault encrypts values and exposes metadata only", (t) => {
  const { store: vault, file } = store(t);
  const secret = vault.setSecret({
    name: "test_api_key",
    value: "private-value-123",
    description: "Test credential",
  }, "Creator");

  assert.equal(secret.name, "TEST_API_KEY");
  assert.equal(secret.hasValue, true);
  assert.equal(Object.hasOwn(secret, "value"), false);
  assert.equal(vault.value("TEST_API_KEY"), "private-value-123");
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /private-value-123/);
  assert.equal(vault.listSecrets()[0].description, "Test credential");
  assert.equal(vault.audit()[0].action, "secret.upsert");
});

test("secret removal deletes encrypted record and writes audit event", (t) => {
  const { store: vault } = store(t);
  const secret = vault.setSecret({ name: "SERVICE_TOKEN", value: "token" }, "Admin");

  assert.equal(vault.removeSecret(secret.id, "Admin").name, "SERVICE_TOKEN");
  assert.equal(vault.value("SERVICE_TOKEN"), null);
  assert.equal(vault.listSecrets().length, 0);
  assert.equal(vault.audit()[0].action, "secret.delete");
});

test("evaluations record live readiness checks and calculate summary", (t) => {
  const { store: vault } = store(t);
  const run = vault.recordEvaluation({
    framework: "Four C",
    score: 75,
    status: "attention",
    sections: [
      {
        label: "Context",
        checks: [
          { id: "one", label: "One", ok: true, detail: "Ready" },
          { id: "two", label: "Two", ok: false, detail: "Missing" },
        ],
      },
    ],
  }, "Creator");

  assert.equal(run.cases, 2);
  assert.equal(run.passedCases, 1);
  assert.equal(run.pass, false);
  assert.deepEqual(vault.listEvaluations().summary, {
    runs: 1,
    average: 75,
    passRate: 0,
    totalCases: 2,
    regressions: 1,
  });
});

test("guardrail catalog describes enforced server protections", () => {
  const rules = activeGuardrails();
  assert.equal(rules.length >= 5, true);
  assert.equal(rules.every((rule) => rule.active && rule.enforcement), true);
  assert.equal(rules.some((rule) => rule.id === "member-data-isolation"), true);
  assert.equal(rules.some((rule) => rule.id === "write-only-secrets"), true);
});

test("governance audit accepts bounded account and task events", (t) => {
  const { store: vault } = store(t);
  const event = vault.recordAudit("kanban.task.update", "Creator", "task_1", "status done");

  assert.equal(event.action, "kanban.task.update");
  assert.equal(vault.audit()[0].target, "task_1");
});

test("role, account and Kanban mutations are wired to the governance audit", () => {
  const auth = fs.readFileSync(new URL("../server/lib/auth.js", import.meta.url), "utf8");
  const lifecycle = fs.readFileSync(new URL("../server/lib/account-lifecycle.js", import.meta.url), "utf8");
  const kanban = fs.readFileSync(new URL("../server/routes/kanban.js", import.meta.url), "utf8");

  assert.match(auth, /recordAudit\("account\.update"/);
  assert.match(lifecycle, /recordAudit\("account\.delete"/);
  assert.match(kanban, /"kanban\.task\.create"/);
  assert.match(kanban, /"kanban\.task\.update"/);
  assert.match(kanban, /"kanban\.dispatch"/);
});
