import assert from "node:assert/strict";
import test from "node:test";

import { PostgresMemberReadAdapter } from "../server/lib/postgres-member-read.js";

const task = {
  id: "tsk_one",
  title: "Private task",
  detail: "",
  status: "doing",
  priority: "normal",
  dueDate: "",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};
const note = {
  id: "note_one",
  title: "Private note",
  content: "Personal",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

function fallbackStore({ tasks = [task], notes = [note] } = {}) {
  return {
    listTasks: () => structuredClone(tasks),
    listNotes: () => structuredClone(notes),
    dashboard: () => ({
      counts: { open: tasks.filter((item) => item.status !== "done").length, doing: 1, due: 0, notes: notes.length },
      tasks: structuredClone(tasks.filter((item) => item.status !== "done")),
      notes: structuredClone(notes),
      updatedAt: "2026-07-28T00:00:00.000Z",
    }),
  };
}

function readyStatus(overrides = {}) {
  return {
    status: "ready",
    inFlight: false,
    outbox: { pending: 0, error: null },
    ...overrides,
  };
}

function fakePool({ tasks = [task], notes = [note], error = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (error) throw error;
      return { rows: (sql.includes("member_tasks") ? tasks : notes).map((payload) => ({ payload })) };
    },
  };
}

test("member canary serves PostgreSQL only when it matches the JSON snapshot", async () => {
  const pool = fakePool({});
  const adapter = new PostgresMemberReadAdapter({
    mode: "member-canary",
    databaseUrl: "postgresql://private",
    shadowStatus: readyStatus,
    fallbackStore: fallbackStore(),
    pool,
  });
  assert.deepEqual(await adapter.listTasks("usr_alpha"), [task]);
  assert.deepEqual(await adapter.listNotes("usr_alpha"), [note]);
  assert.deepEqual(await adapter.dashboard("usr_alpha"), {
    counts: { open: 1, doing: 1, due: 0, notes: 1 },
    tasks: [task],
    notes: [note],
    updatedAt: "2026-07-28T00:00:00.000Z",
  });
  assert.equal(adapter.status().postgresReads, 3);
  assert.equal(adapter.status().jsonFallbacks, 0);
  assert.equal(pool.calls.every((call) => call.params[0] === "usr_alpha"), true);
});

test("pending outbox guarantees read-after-write consistency through JSON", async () => {
  const pool = fakePool({});
  const adapter = new PostgresMemberReadAdapter({
    mode: "member-canary",
    databaseUrl: "postgresql://private",
    shadowStatus: () => readyStatus({ outbox: { pending: 2, error: null } }),
    fallbackStore: fallbackStore(),
    pool,
  });
  assert.deepEqual(await adapter.listTasks("usr_alpha"), [task]);
  assert.equal(pool.calls.length, 0);
  assert.equal(adapter.status().consistencyFallbacks, 1);
  assert.equal(adapter.status().lastFallbackReason, "outbox_pending");
});

test("canary mismatch returns JSON and records parity fallback", async () => {
  const staleTask = { ...task, title: "Stale SQL task" };
  const adapter = new PostgresMemberReadAdapter({
    mode: "member-canary",
    databaseUrl: "postgresql://private",
    shadowStatus: readyStatus,
    fallbackStore: fallbackStore(),
    pool: fakePool({ tasks: [staleTask] }),
  });
  assert.deepEqual(await adapter.listTasks("usr_alpha"), [task]);
  assert.equal(adapter.status().parityFallbacks, 1);
  assert.equal(adapter.status().lastFallbackReason, "canary_mismatch");
});

test("SQL errors fall back without exposing the database URL", async () => {
  const secret = "postgresql://reader:secret@postgres/private";
  const adapter = new PostgresMemberReadAdapter({
    mode: "member",
    databaseUrl: secret,
    shadowStatus: readyStatus,
    fallbackStore: fallbackStore(),
    pool: fakePool({ error: new Error(`connection failed for ${secret}`) }),
  });
  assert.deepEqual(await adapter.listNotes("usr_alpha"), [note]);
  assert.equal(adapter.status().queryFallbacks, 1);
  assert.equal(JSON.stringify(adapter.status()).includes(secret), false);
});

test("json mode never opens the PostgreSQL read path", async () => {
  const pool = fakePool({});
  const adapter = new PostgresMemberReadAdapter({
    mode: "json",
    databaseUrl: "postgresql://private",
    shadowStatus: readyStatus,
    fallbackStore: fallbackStore(),
    pool,
  });
  assert.deepEqual(await adapter.listTasks("usr_alpha"), [task]);
  assert.equal(pool.calls.length, 0);
  assert.equal(adapter.status().enabled, false);
});

