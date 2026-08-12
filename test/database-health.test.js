import assert from "node:assert/strict";
import test from "node:test";

import { databaseHealth } from "../assets/js/pages/dashboard.js";

// The shape /api/health actually serves while the migration runs, taken from a
// live production response.
const healthy = {
  enabled: true,
  sourceOfTruth: "postgres",
  mode: "primary-replay",
  status: "ready",
  consecutiveFailures: 0,
  lastSuccessAt: new Date().toISOString(),
  outbox: { pending: 0, oldestAt: null, bytes: 0, error: null },
  reads: { jsonFallbacks: 0, consistencyFallbacks: 0, error: null },
  writes: { fallbackWrites: 0, error: null },
  authReads: { refreshes: 1, refreshFailures: 0, error: null },
  authWrites: { fallbackWrites: 0, error: null },
};

test("a healthy migration is quiet", () => {
  const state = databaseHealth(healthy);
  assert.equal(state.level, "ok");
  assert.equal(state.label, "Postgres");
  assert.match(state.detail, /Postgres/);
  assert.deepEqual(state.reasons, []);
});

test("falling back to JSON is normal and does not raise an alarm", () => {
  // The consistency gate dropping to JSON is the design working, not a fault.
  // Warning on it would train the owner to ignore this indicator.
  const state = databaseHealth({
    ...healthy,
    reads: { jsonFallbacks: 12, consistencyFallbacks: 4, error: null },
    writes: { fallbackWrites: 3, error: null },
  });
  assert.equal(state.level, "ok");
});

test("a growing outbox escalates, because it means writes are not landing", () => {
  assert.equal(databaseHealth({ ...healthy, outbox: { pending: 10 } }).level, "ok");

  const warn = databaseHealth({ ...healthy, outbox: { pending: 40 } });
  assert.equal(warn.level, "warn");
  assert.match(warn.detail, /40 writes queued/);

  const fail = databaseHealth({ ...healthy, outbox: { pending: 500 } });
  assert.equal(fail.level, "fail");
});

test("refresh failures and repeated sync failures are never merely a warning", () => {
  const refresh = databaseHealth({ ...healthy, authReads: { refreshFailures: 2 } });
  assert.equal(refresh.level, "fail", "a stale auth cache decides who can sign in");
  assert.match(refresh.detail, /2 refresh failures/);

  const failing = databaseHealth({ ...healthy, consecutiveFailures: 3 });
  assert.equal(failing.level, "warn");
  assert.match(failing.detail, /3 syncs failed in a row/);

  const errored = databaseHealth({ ...healthy, outbox: { pending: 0, error: "connection refused" } });
  assert.equal(errored.level, "fail");
  assert.match(errored.detail, /connection refused/);
});

test("a workspace with no Postgres at all is reported as such, not as broken", () => {
  const state = databaseHealth({ enabled: false });
  assert.equal(state.level, "off");
  assert.equal(state.label, "JSON only");

  // A missing section must not throw or invent a failure either.
  assert.equal(databaseHealth().level, "off");
  assert.equal(databaseHealth(undefined).level, "off");
});

test("an unready status is surfaced even when every counter looks clean", () => {
  const state = databaseHealth({ ...healthy, status: "connecting" });
  assert.equal(state.level, "warn");
  assert.match(state.detail, /status connecting/);
});
