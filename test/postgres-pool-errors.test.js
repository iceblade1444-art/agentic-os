import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PostgresAuthReadAdapter } from "../server/lib/postgres-auth-read.js";
import { PostgresAuthWriteAdapter } from "../server/lib/postgres-auth-write.js";
import { PostgresMemberReadAdapter } from "../server/lib/postgres-member-read.js";
import { PostgresMemberWriteAdapter } from "../server/lib/postgres-member-write.js";

const databaseUrl = "postgresql://agent:private@postgres/agentic_os";
const shadowStatus = () => ({
  status: "ready",
  inFlight: false,
  outbox: { pending: 0, error: null },
});

const pool = () => new EventEmitter();

test("persistent PostgreSQL pools absorb background connection errors", () => {
  const authReadPool = pool();
  const authWritePool = pool();
  const memberReadPool = pool();
  const memberWritePool = pool();
  const authRead = new PostgresAuthReadAdapter({
    mode: "canary",
    databaseUrl,
    shadowStatus,
    userStore: {},
    sessionStore: {},
    pool: authReadPool,
  });
  const authWrite = new PostgresAuthWriteAdapter({
    mode: "shadow",
    dataDir: ".",
    databaseUrl,
    shadowStatus,
    pool: authWritePool,
  });
  const memberRead = new PostgresMemberReadAdapter({
    mode: "member",
    databaseUrl,
    shadowStatus,
    fallbackStore: {},
    pool: memberReadPool,
  });
  const memberWrite = new PostgresMemberWriteAdapter({
    mode: "member-shadow",
    databaseUrl,
    shadowStatus,
    fallbackStore: {},
    pool: memberWritePool,
  });

  for (const candidate of [authReadPool, authWritePool, memberReadPool, memberWritePool]) {
    candidate.emit("error", new Error(`connection terminated for ${databaseUrl}`));
  }

  assert.equal(authRead.status().cacheReady, false);
  for (const adapter of [authRead, authWrite, memberRead, memberWrite]) {
    assert.match(adapter.status().error, /connection terminated/);
    assert.doesNotMatch(adapter.status().error, /private/);
  }
});
