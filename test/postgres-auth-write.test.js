import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PostgresAuthWriteAdapter } from "../server/lib/postgres-auth-write.js";

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function temporaryData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-auth-write-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakePool({ error = null } = {}) {
  const calls = [];
  return {
    calls,
    async connect() {
      if (error) throw error;
      return {
        async query(sql, params = []) {
          calls.push({ sql, params });
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

async function settled(adapter) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (adapter.status().pendingGroups === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("PostgreSQL auth writer did not settle");
}

const ready = () => ({ status: "ready" });

test("auth shadow mirrors password hashes without exposing them in telemetry", async (t) => {
  const dataDir = temporaryData(t);
  const passwordHash = "private-password-hash";
  write(path.join(dataDir, "users.json"), {
    users: [{
      id: "usr_alpha",
      name: "Alpha",
      email: "alpha@example.com",
      role: "Member",
      avatar: "",
      disabled: false,
      salt: "private-salt",
      passwordHash,
      sessionVersion: 2,
      emailVerifiedAt: "2026-07-28T00:00:00.000Z",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    }],
  });
  const pool = fakePool();
  const adapter = new PostgresAuthWriteAdapter({
    mode: "shadow",
    dataDir,
    databaseUrl: "postgresql://private",
    shadowStatus: ready,
    pool,
  });

  assert.equal(adapter.request(path.join(dataDir, "users.json")), true);
  await settled(adapter);

  const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO agentic_os_shadow.users"));
  assert.equal(insert.params[7], passwordHash);
  assert.equal(insert.params[8], 2);
  assert.equal(adapter.status().postgresWrites, 1);
  assert.equal(JSON.stringify(adapter.status()).includes(passwordHash), false);
});

test("session, MFA and account token files have isolated transactional mirrors", async (t) => {
  const dataDir = temporaryData(t);
  write(path.join(dataDir, "sessions.json"), {
    sessions: [{
      id: "ses_one",
      userId: "usr_alpha",
      kind: "mobile",
      label: "MILA mobile",
      createdAt: "2026-07-28T00:00:00.000Z",
      lastSeenAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2026-08-28T00:00:00.000Z",
      revokedAt: "",
    }],
  });
  write(path.join(dataDir, "mfa.json"), {
    records: { usr_alpha: { enabledAt: "2026-07-28T00:00:00.000Z", secret: { ciphertext: "encrypted" } } },
  });
  write(path.join(dataDir, "account-tokens.json"), {
    tokens: [{
      digest: "digest",
      userId: "usr_alpha",
      purpose: "reset_password",
      createdAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2026-07-28T01:00:00.000Z",
    }],
  });
  const pool = fakePool();
  const adapter = new PostgresAuthWriteAdapter({
    mode: "shadow",
    dataDir,
    databaseUrl: "postgresql://private",
    shadowStatus: ready,
    pool,
  });

  for (const file of ["sessions.json", "mfa.json", "account-tokens.json"]) {
    assert.equal(adapter.request(path.join(dataDir, file)), true);
  }
  await settled(adapter);

  assert.equal(pool.calls.some((call) => call.sql.includes("INSERT INTO agentic_os_shadow.sessions")), true);
  assert.equal(pool.calls.some((call) => call.sql.includes("INSERT INTO agentic_os_shadow.mfa_records")), true);
  assert.equal(pool.calls.some((call) => call.sql.includes("INSERT INTO agentic_os_shadow.account_tokens")), true);
  assert.equal(adapter.status().postgresWrites, 3);
});

test("auth writes fall back to durable JSON and redact the database URL", async (t) => {
  const dataDir = temporaryData(t);
  write(path.join(dataDir, "sessions.json"), { sessions: [] });
  const secret = "postgresql://auth:secret@postgres/private";
  const adapter = new PostgresAuthWriteAdapter({
    mode: "shadow",
    dataDir,
    databaseUrl: secret,
    shadowStatus: ready,
    pool: fakePool({ error: new Error(`connection refused for ${secret}`) }),
  });

  assert.equal(adapter.request(path.join(dataDir, "sessions.json")), true);
  await settled(adapter);

  assert.equal(fs.existsSync(path.join(dataDir, "sessions.json")), true);
  assert.equal(adapter.status().queryFallbacks, 1);
  assert.equal(adapter.status().lastFallbackReason, "query_error");
  assert.equal(JSON.stringify(adapter.status()).includes(secret), false);
});

test("auth primary exposes a commit barrier and rejects failed SQL delivery", async (t) => {
  const dataDir = temporaryData(t);
  write(path.join(dataDir, "sessions.json"), { sessions: [] });
  const success = new PostgresAuthWriteAdapter({
    mode: "primary",
    dataDir,
    databaseUrl: "postgresql://private",
    shadowStatus: () => ({ status: "error" }),
    pool: fakePool(),
  });
  success.request(path.join(dataDir, "sessions.json"));
  assert.deepEqual(await success.commit(["sessions"]), { required: true, committed: 1 });
  assert.equal(success.status().primary, true);

  const failed = new PostgresAuthWriteAdapter({
    mode: "primary",
    dataDir,
    databaseUrl: "postgresql://private",
    shadowStatus: () => ({ status: "error" }),
    pool: fakePool({ error: new Error("database unavailable") }),
  });
  failed.request(path.join(dataDir, "sessions.json"));
  await assert.rejects(
    failed.commit(["sessions"]),
    (error) => error.code === "postgres_commit_failed" && error.status === 503,
  );
});

test("json mode and unrelated runtime files never open the auth SQL path", async (t) => {
  const dataDir = temporaryData(t);
  write(path.join(dataDir, "users.json"), { users: [] });
  const pool = fakePool();
  const adapter = new PostgresAuthWriteAdapter({
    mode: "json",
    dataDir,
    databaseUrl: "postgresql://private",
    shadowStatus: ready,
    pool,
  });

  assert.equal(adapter.request(path.join(dataDir, "users.json")), true);
  assert.equal(adapter.request(path.join(dataDir, "member-workspaces", `${"a".repeat(64)}.json`)), false);
  await settled(adapter);

  assert.equal(pool.calls.length, 0);
  assert.equal(adapter.status().enabled, false);
  assert.equal(adapter.status().jsonWrites, 1);
});
