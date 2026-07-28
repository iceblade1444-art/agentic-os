import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPostgresMigrationPlan,
  migrationCounts,
  parityReport,
} from "../server/lib/postgres-migration.js";

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

test("PostgreSQL migration plan preserves account and personal workspace ownership", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-pg-"));
  const userId = "usr_member";
  write(path.join(root, "users.json"), {
    version: 1,
    users: [{
      id: userId,
      name: "Member",
      email: "member@example.com",
      role: "Member",
      avatar: "",
      disabled: false,
      salt: "salt",
      passwordHash: "password-hash",
      sessionVersion: 3,
      emailVerifiedAt: "2026-07-28T00:00:00.000Z",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    }],
  });
  write(path.join(root, "sessions.json"), {
    sessions: [{
      id: "ses_one",
      userId,
      kind: "mobile",
      label: "MILA mobile",
      createdAt: "2026-07-28T00:00:00.000Z",
      lastSeenAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2026-08-28T00:00:00.000Z",
      revokedAt: "",
    }],
  });
  write(path.join(root, "onboarding.json"), {
    workspace: { name: "Milana Premium", updatedAt: "2026-07-28T00:00:00.000Z" },
    users: { [userId]: { locale: "ru-RU", updatedAt: "2026-07-28T00:00:00.000Z" } },
  });
  write(path.join(root, "mfa.json"), {
    records: { [userId]: { enabledAt: "2026-07-28T00:00:00.000Z", secret: { ciphertext: "encrypted" } } },
  });
  write(path.join(root, "account-tokens.json"), {
    tokens: [{
      digest: "token-digest",
      userId,
      purpose: "reset_password",
      createdAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2026-07-28T01:00:00.000Z",
    }],
  });
  const workspaceKey = crypto.createHash("sha256").update(userId).digest("hex");
  write(path.join(root, "member-workspaces", `${workspaceKey}.json`), {
    tasks: [{
      id: "tsk_one",
      title: "Private task",
      detail: "",
      status: "todo",
      priority: "normal",
      dueDate: "",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    }],
    notes: [{
      id: "note_one",
      title: "Private note",
      content: "Personal",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    }],
  });

  const plan = buildPostgresMigrationPlan(root);
  assert.deepEqual(plan.counts, {
    users: 1,
    sessions: 1,
    tasks: 1,
    notes: 1,
    onboardingProfiles: 1,
    workspaceContexts: 1,
    mfaRecords: 1,
    accountTokens: 1,
  });
  assert.equal(plan.rows.tasks[0].userId, userId);
  assert.equal(plan.rows.notes[0].userId, userId);
  assert.equal(plan.rows.users[0].passwordHash, "password-hash");
  assert.equal(plan.rows.mfaRecords[0].record.secret.ciphertext, "encrypted");
  assert.deepEqual(plan.orphanWorkspaceFiles, []);
  assert.match(plan.sourceHash, /^[a-f0-9]{64}$/);
});

test("PostgreSQL migration refuses silent orphan workspaces and reports parity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-pg-orphan-"));
  write(path.join(root, "member-workspaces", `${"a".repeat(64)}.json`), { tasks: [], notes: [] });

  const plan = buildPostgresMigrationPlan(root);
  assert.equal(plan.orphanWorkspaceFiles.length, 1);
  const counts = migrationCounts(plan.rows);
  const report = parityReport(counts, counts, plan.orphanWorkspaceFiles);
  assert.equal(report.ok, false);
  assert.deepEqual(report.mismatches, []);

  const mismatch = parityReport({ ...counts, users: 1 }, counts);
  assert.equal(mismatch.ok, false);
  assert.deepEqual(mismatch.mismatches, [{ key: "users", source: 1, database: 0 }]);
});

