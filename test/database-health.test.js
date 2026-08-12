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
  assert.equal(state.source, "postgres");
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

const reasonFor = (state, code) => state.reasons.find((reason) => reason.code === code);

test("a growing outbox escalates, because it means writes are not landing", () => {
  assert.equal(databaseHealth({ ...healthy, outbox: { pending: 10 } }).level, "ok");

  const warn = databaseHealth({ ...healthy, outbox: { pending: 40 } });
  assert.equal(warn.level, "warn");
  assert.equal(reasonFor(warn, "outbox").value, 40);

  const fail = databaseHealth({ ...healthy, outbox: { pending: 500 } });
  assert.equal(fail.level, "fail");
});

test("refresh failures and repeated sync failures are never merely a warning", () => {
  const refresh = databaseHealth({ ...healthy, authReads: { refreshFailures: 2 } });
  assert.equal(refresh.level, "fail", "a stale auth cache decides who can sign in");
  assert.equal(reasonFor(refresh, "refreshFailures").value, 2);

  const failing = databaseHealth({ ...healthy, consecutiveFailures: 3 });
  assert.equal(failing.level, "warn");
  assert.equal(reasonFor(failing, "syncFailures").value, 3);

  const errored = databaseHealth({ ...healthy, outbox: { pending: 0, error: "connection refused" } });
  assert.equal(errored.level, "fail");
  assert.equal(reasonFor(errored, "error").value, "connection refused");
});

test("a workspace with no Postgres at all is reported as such, not as broken", () => {
  const state = databaseHealth({ enabled: false });
  assert.equal(state.level, "off");
  assert.equal(state.source, "off");

  // A missing section must not throw or invent a failure either.
  assert.equal(databaseHealth().level, "off");
  assert.equal(databaseHealth(undefined).level, "off");
});

test("an unready status is surfaced even when every counter looks clean", () => {
  const state = databaseHealth({ ...healthy, status: "connecting" });
  assert.equal(state.level, "warn");
  assert.equal(reasonFor(state, "status").value, "connecting");
});

test("nothing user-visible is decided here: no prose leaks out of the rules", () => {
  // The wording lives in the page so it can be translated; a regression that
  // moved copy back in here would silently make the dashboard English-only.
  for (const input of [healthy, { enabled: false }, { ...healthy, consecutiveFailures: 2 }]) {
    const state = databaseHealth(input);
    assert.equal(state.label, undefined);
    assert.equal(state.detail, undefined);
    for (const reason of state.reasons) {
      assert.match(reason.code, /^[a-zA-Z]+$/, "a reason must be a code, not a sentence");
    }
  }
});
