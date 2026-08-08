import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { PostgresAuthReadAdapter } from "../server/lib/postgres-auth-read.js";

const sourceHash = "a".repeat(64);
const salt = "test-salt";
const password = "correct horse battery";
const passwordHash = crypto.scryptSync(password, salt, 64).toString("base64url");
const rawUser = {
  id: "usr_alpha",
  name: "Alpha",
  email: "alpha@example.com",
  role: "Member",
  avatar: "",
  disabled: false,
  salt,
  passwordHash,
  sessionVersion: 2,
  emailVerifiedAt: "2026-07-28T00:00:00.000Z",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};
const rawSession = {
  id: "ses_one",
  userId: rawUser.id,
  kind: "mobile",
  label: "MILA mobile",
  createdAt: "2026-07-28T00:00:00.000Z",
  lastSeenAt: "2026-07-28T00:00:00.000Z",
  expiresAt: "2099-08-28T00:00:00.000Z",
  revokedAt: "",
};
const sessionUser = {
  id: rawUser.id,
  name: rawUser.name,
  email: rawUser.email,
  role: rawUser.role,
  avatar: "",
  disabled: false,
  createdAt: rawUser.createdAt,
  updatedAt: rawUser.updatedAt,
  emailVerified: true,
  // No approvedAt on the record: accounts that predate approval stay approved.
  approved: true,
  approvedAt: "",
  sessionVersion: 2,
};
const publicSession = {
  id: rawSession.id,
  kind: rawSession.kind,
  label: rawSession.label,
  createdAt: rawSession.createdAt,
  lastSeenAt: rawSession.lastSeenAt,
  expiresAt: rawSession.expiresAt,
  current: true,
};

function stores(overrides = {}) {
  let touches = 0;
  return {
    userStore: {
      authenticate: (email, candidate) =>
        email === rawUser.email && candidate === password ? structuredClone(sessionUser) : null,
      sessionUser: (id) => id === rawUser.id ? structuredClone(sessionUser) : null,
      list: () => [{ ...sessionUser, sessionVersion: undefined }].map(({ sessionVersion: _, ...user }) => user),
      ...overrides.userStore,
    },
    sessionStore: {
      active: (id, userId) => id === rawSession.id && userId === rawUser.id ? rawSession : null,
      touch: () => { touches += 1; return true; },
      list: (userId, currentId) => userId === rawUser.id ? [{ ...publicSession, current: currentId === rawSession.id }] : [],
      ...overrides.sessionStore,
    },
    touches: () => touches,
  };
}

function fakePool({ users = [rawUser], sessions = [rawSession], hash = sourceHash, error = null } = {}) {
  return {
    async connect() {
      if (error) throw error;
      return {
        async query(sql) {
          if (sql.includes("FROM agentic_os_shadow.users")) {
            return { rows: users.map((payload) => ({ payload })) };
          }
          if (sql.includes("FROM agentic_os_shadow.sessions")) {
            return { rows: sessions.map((payload) => ({ payload })) };
          }
          if (sql.includes("migration_runs")) return { rows: [{ source_hash: hash }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

const ready = (overrides = {}) => () => ({
  status: "ready",
  inFlight: false,
  sourceHash,
  outbox: { pending: 0, error: null },
  ...overrides,
});

test("auth canary serves matching PostgreSQL users and sessions", async () => {
  const fallback = stores();
  const adapter = new PostgresAuthReadAdapter({
    mode: "canary",
    databaseUrl: "postgresql://private",
    shadowStatus: ready(),
    userStore: fallback.userStore,
    sessionStore: fallback.sessionStore,
    pool: fakePool(),
  });
  await adapter.refresh();

  assert.deepEqual(adapter.authenticate(rawUser.email, password), sessionUser);
  assert.deepEqual(adapter.sessionUser(rawUser.id), sessionUser);
  assert.equal(adapter.touchSession(rawSession.id, rawUser.id), true);
  assert.deepEqual(adapter.listSessions(rawUser.id, rawSession.id), [publicSession]);
  assert.equal(fallback.touches(), 1);
  assert.equal(adapter.status().postgresReads, 4);
  assert.equal(adapter.status().jsonFallbacks, 0);
  assert.equal(adapter.status().cacheReady, true);
});

test("auth canary mismatch returns JSON and records parity fallback", async () => {
  const fallback = stores({
    userStore: {
      sessionUser: () => ({ ...sessionUser, name: "JSON Alpha" }),
    },
  });
  const adapter = new PostgresAuthReadAdapter({
    mode: "canary",
    databaseUrl: "postgresql://private",
    shadowStatus: ready(),
    userStore: fallback.userStore,
    sessionStore: fallback.sessionStore,
    pool: fakePool(),
  });
  await adapter.refresh();

  assert.equal(adapter.sessionUser(rawUser.id).name, "JSON Alpha");
  assert.equal(adapter.status().parityFallbacks, 1);
  assert.equal(adapter.status().lastFallbackReason, "canary_mismatch");
});

test("outbox and stale cache force JSON without consulting cached auth", async () => {
  const fallback = stores();
  const adapter = new PostgresAuthReadAdapter({
    mode: "postgres",
    databaseUrl: "postgresql://private",
    shadowStatus: ready({ outbox: { pending: 1, error: null } }),
    userStore: fallback.userStore,
    sessionStore: fallback.sessionStore,
    pool: fakePool(),
  });
  await adapter.refresh();
  assert.deepEqual(adapter.sessionUser(rawUser.id), sessionUser);
  assert.equal(adapter.status().lastFallbackReason, "outbox_pending");

  adapter.shadowStatus = ready({ sourceHash: "b".repeat(64) });
  assert.deepEqual(adapter.sessionUser(rawUser.id), sessionUser);
  assert.equal(adapter.status().lastFallbackReason, "cache_stale");
  assert.equal(adapter.status().consistencyFallbacks, 2);
});

test("an expired cache falls back to JSON even when its source hash still matches", async () => {
  const fallback = stores();
  const adapter = new PostgresAuthReadAdapter({
    mode: "postgres",
    databaseUrl: "postgresql://private",
    shadowStatus: ready(),
    userStore: fallback.userStore,
    sessionStore: fallback.sessionStore,
    cacheMaxAgeMs: 3000,
    pool: fakePool(),
  });
  await adapter.refresh();
  adapter.metrics.lastRefreshAt = new Date(Date.now() - 4000).toISOString();

  assert.deepEqual(adapter.sessionUser(rawUser.id), sessionUser);
  assert.equal(adapter.status().postgresReads, 0);
  assert.equal(adapter.status().lastFallbackReason, "cache_expired");
});

test("refresh failures keep JSON auth available and redact the database URL", async () => {
  const fallback = stores();
  const secret = "postgresql://auth:secret@postgres/private";
  const adapter = new PostgresAuthReadAdapter({
    mode: "canary",
    databaseUrl: secret,
    shadowStatus: ready(),
    userStore: fallback.userStore,
    sessionStore: fallback.sessionStore,
    pool: fakePool({ error: new Error(`connection failed for ${secret}`) }),
  });

  await adapter.refresh();

  assert.deepEqual(adapter.authenticate(rawUser.email, password), sessionUser);
  assert.equal(adapter.status().refreshFailures, 1);
  assert.equal(adapter.status().lastFallbackReason, "cache_not_ready");
  assert.equal(JSON.stringify(adapter.status()).includes(secret), false);
});
