import assert from "node:assert/strict";
import test from "node:test";

import { PostgresShadowSync } from "../server/lib/postgres-shadow-sync.js";

test("PostgreSQL shadow sync stays disabled without an explicit database rollout", async () => {
  const sync = new PostgresShadowSync({ enabled: true, databaseUrl: "" });
  assert.deepEqual(sync.status(), {
    enabled: false,
    mode: "shadow",
    status: "disabled",
    intervalSeconds: 30,
    inFlight: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    consecutiveFailures: 0,
    sourceHash: null,
    counts: null,
    outbox: { pending: 0, oldestAt: null, bytes: 0, error: null },
    error: null,
  });
  assert.deepEqual(await sync.run(), { skipped: true, reason: "disabled" });
});

test("PostgreSQL shadow sync reports bounded success and coalesces concurrent runs", async () => {
  let release;
  let calls = 0;
  const migrate = () => {
    calls += 1;
    return new Promise((resolve) => {
      release = () => resolve({
        ok: true,
        sourceHash: "a".repeat(64),
        sourceCounts: { users: 2, sessions: 1 },
      });
    });
  };
  const sync = new PostgresShadowSync({
    enabled: true,
    databaseUrl: "postgresql://private",
    intervalMs: 5000,
    migrate,
  });

  const first = sync.run();
  assert.deepEqual(await sync.run(), { skipped: true, reason: "in_flight" });
  assert.equal(sync.status().inFlight, true);
  release();
  await first;

  const status = sync.status();
  assert.equal(calls, 1);
  assert.equal(status.status, "ready");
  assert.equal(status.inFlight, false);
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.sourceHash, "a".repeat(64));
  assert.deepEqual(status.counts, { users: 2, sessions: 1 });
  assert.equal(status.error, null);
});

test("PostgreSQL shadow sync contains failures without exposing connection details", async () => {
  const secret = "postgresql://user:top-secret@database/private";
  const sync = new PostgresShadowSync({
    enabled: true,
    databaseUrl: secret,
    migrate: async () => {
      throw new Error(`connection refused for ${secret}`);
    },
  });
  const result = await sync.run();
  assert.equal(result.ok, false);
  assert.equal(sync.status().status, "error");
  assert.equal(sync.status().consecutiveFailures, 1);
  assert.equal(JSON.stringify(sync.status()).includes(secret), false);
  assert.match(sync.status().error, /\[database\]/);
});

test("PostgreSQL shadow sync acknowledges outbox only after success", async () => {
  const events = [{ id: "evt_one" }, { id: "evt_two" }];
  const acknowledged = [];
  const outbox = {
    snapshot: () => events,
    acknowledge: (ids) => acknowledged.push(ids),
    status: () => ({ pending: events.length, oldestAt: null, bytes: 100, error: null }),
  };
  const failed = new PostgresShadowSync({
    enabled: true,
    databaseUrl: "postgresql://private",
    outbox,
    migrate: async () => { throw new Error("offline"); },
  });
  await failed.run();
  assert.deepEqual(acknowledged, []);
  assert.equal(failed.debounceTimer, null);
  await failed.stop();

  const successful = new PostgresShadowSync({
    enabled: true,
    databaseUrl: "postgresql://private",
    outbox,
    migrate: async () => ({ ok: true, sourceHash: "b".repeat(64), sourceCounts: {} }),
  });
  await successful.run();
  assert.deepEqual(acknowledged, [["evt_one", "evt_two"]]);
  await successful.stop();
});

test("a mutation during a successful sync schedules one debounced follow-up", async () => {
  let release;
  const sync = new PostgresShadowSync({
    enabled: true,
    databaseUrl: "postgresql://private",
    debounceMs: 5000,
    migrate: () => new Promise((resolve) => {
      release = () => resolve({ ok: true, sourceHash: "c".repeat(64), sourceCounts: {} });
    }),
  });
  const running = sync.run();
  assert.equal(sync.request(), true);
  release();
  await running;
  assert.notEqual(sync.debounceTimer, null);
  await sync.stop();
  assert.equal(sync.debounceTimer, null);
});

test("server health exposes shadow state and shuts the worker down cleanly", async () => {
  const fs = await import("node:fs");
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  assert.match(server, /reads: postgresMemberReads\.status\(\)/);
  assert.match(server, /writes: postgresMemberWrites\.status\(\)/);
  assert.match(server, /authWrites: postgresAuthWrites\.status\(\)/);
  assert.match(server, /postgresShadow\.start\(\)/);
  assert.match(server, /postgresShadow\.enabled && postgresOutbox\.record\(file\)/);
  assert.match(server, /await postgresShadow\.stop\(\)/);
  assert.match(server, /await postgresMemberWrites\.stop\(\)/);
  assert.match(server, /await postgresAuthWrites\.stop\(\)/);
});
