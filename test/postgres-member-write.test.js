import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemberWorkspaceStore } from "../server/lib/member-workspace.js";
import { PostgresMemberWriteAdapter } from "../server/lib/postgres-member-write.js";

function temporaryStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-pg-write-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new MemberWorkspaceStore(dir);
}

function fakePool({ error = null } = {}) {
  const calls = [];
  let releases = 0;
  return {
    calls,
    get releases() { return releases; },
    async connect() {
      if (error) throw error;
      return {
        async query(sql, params = []) {
          calls.push({ sql, params });
          return { rows: [] };
        },
        release() { releases += 1; },
      };
    },
  };
}

const ready = () => ({ status: "ready" });

test("member shadow writes keep JSON and transactionally copy the user workspace", async (t) => {
  const store = temporaryStore(t);
  const pool = fakePool();
  const adapter = new PostgresMemberWriteAdapter({
    mode: "member-shadow",
    databaseUrl: "postgresql://private",
    shadowStatus: ready,
    fallbackStore: store,
    pool,
  });

  const task = await adapter.createTask("usr_alpha", {
    title: "Persist this task",
    priority: "high",
  });
  const note = await adapter.createNote("usr_alpha", {
    title: "Persist this note",
    content: "Private",
  });

  assert.equal(store.listTasks("usr_alpha")[0].id, task.id);
  assert.equal(store.listNotes("usr_alpha")[0].id, note.id);
  assert.equal(pool.calls.filter((call) => call.sql === "BEGIN").length, 2);
  assert.equal(pool.calls.filter((call) => call.sql === "COMMIT").length, 2);
  assert.equal(pool.calls.some((call) =>
    call.sql.includes("member_tasks") && call.params[9]?.userId === "usr_alpha"), true);
  assert.equal(pool.calls.some((call) =>
    call.sql.includes("member_notes") && call.params[6]?.userId === "usr_alpha"), true);
  assert.equal(pool.releases, 2);
  assert.equal(adapter.status().jsonWrites, 2);
  assert.equal(adapter.status().postgresWrites, 2);
  assert.equal(adapter.status().fallbackWrites, 0);
});

test("a PostgreSQL outage never loses an accepted JSON mutation or exposes its URL", async (t) => {
  const store = temporaryStore(t);
  const secret = "postgresql://member:secret@postgres/private";
  const adapter = new PostgresMemberWriteAdapter({
    mode: "member-shadow",
    databaseUrl: secret,
    shadowStatus: ready,
    fallbackStore: store,
    pool: fakePool({ error: new Error(`connection refused for ${secret}`) }),
  });

  const task = await adapter.createTask("usr_alpha", { title: "Survives outage" });

  assert.equal(store.listTasks("usr_alpha")[0].id, task.id);
  assert.equal(adapter.status().postgresWrites, 0);
  assert.equal(adapter.status().queryFallbacks, 1);
  assert.equal(adapter.status().lastFallbackReason, "query_error");
  assert.equal(JSON.stringify(adapter.status()).includes(secret), false);
});

test("member primary requires SQL commit and rolls JSON back on failure", async (t) => {
  const store = temporaryStore(t);
  await store.createTask("usr_alpha", { title: "Existing task" });
  const adapter = new PostgresMemberWriteAdapter({
    mode: "member-primary",
    databaseUrl: "postgresql://private",
    shadowStatus: ready,
    fallbackStore: store,
    pool: fakePool({ error: new Error("database unavailable") }),
  });

  await assert.rejects(
    adapter.createTask("usr_alpha", { title: "Must not survive" }),
    (error) => error.code === "postgres_commit_failed" && error.status === 503,
  );

  assert.deepEqual(store.listTasks("usr_alpha").map((task) => task.title), ["Existing task"]);
  assert.equal(adapter.status().primary, true);
  assert.equal(adapter.status().queryFallbacks, 1);
});

test("shadow readiness gate leaves recovery to the durable outbox", async (t) => {
  const store = temporaryStore(t);
  const pool = fakePool();
  const adapter = new PostgresMemberWriteAdapter({
    mode: "member-shadow",
    databaseUrl: "postgresql://private",
    shadowStatus: () => ({ status: "error" }),
    fallbackStore: store,
    pool,
  });

  await adapter.createNote("usr_alpha", { title: "Queued for recovery" });

  assert.equal(store.listNotes("usr_alpha").length, 1);
  assert.equal(pool.calls.length, 0);
  assert.equal(adapter.status().gateFallbacks, 1);
  assert.equal(adapter.status().lastFallbackReason, "shadow_not_ready");
});

test("json write mode never opens PostgreSQL", async (t) => {
  const store = temporaryStore(t);
  const pool = fakePool();
  const adapter = new PostgresMemberWriteAdapter({
    mode: "json",
    databaseUrl: "postgresql://private",
    shadowStatus: ready,
    fallbackStore: store,
    pool,
  });

  await adapter.createTask("usr_alpha", { title: "JSON rollback mode" });

  assert.equal(store.listTasks("usr_alpha").length, 1);
  assert.equal(pool.calls.length, 0);
  assert.equal(adapter.status().enabled, false);
  assert.equal(adapter.status().jsonWrites, 1);
});

test("account cleanup clears PostgreSQL even when no JSON workspace file exists", async (t) => {
  const store = temporaryStore(t);
  const pool = fakePool();
  const adapter = new PostgresMemberWriteAdapter({
    mode: "member-shadow",
    databaseUrl: "postgresql://private",
    shadowStatus: ready,
    fallbackStore: store,
    pool,
  });

  assert.equal(await adapter.remove("usr_without_file"), false);

  assert.equal(pool.calls.some((call) =>
    call.sql.includes("DELETE FROM agentic_os_shadow.member_tasks")
    && call.params[0] === "usr_without_file"), true);
  assert.equal(pool.calls.some((call) =>
    call.sql.includes("DELETE FROM agentic_os_shadow.member_notes")
    && call.params[0] === "usr_without_file"), true);
  assert.equal(adapter.status().postgresWrites, 1);
  assert.equal(adapter.status().jsonWrites, 0);
});
