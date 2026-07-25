import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MemberWorkspaceStore } from "../server/lib/member-workspace.js";

function temporaryStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-members-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new MemberWorkspaceStore(dir);
}

test("member tasks and notes are isolated by authenticated user id", (t) => {
  const store = temporaryStore(t);
  const alphaTask = store.createTask("usr_alpha", {
    title: "Alpha task",
    detail: "Private to alpha",
    priority: "high",
    dueDate: "2026-08-01",
  });
  const alphaNote = store.createNote("usr_alpha", { title: "Alpha note", content: "Private note" });
  store.createTask("usr_beta", { title: "Beta task" });
  store.createNote("usr_beta", { title: "Beta note" });

  assert.deepEqual(store.listTasks("usr_alpha").map((task) => task.title), ["Alpha task"]);
  assert.deepEqual(store.listNotes("usr_alpha").map((note) => note.title), ["Alpha note"]);
  assert.equal(store.updateTask("usr_beta", alphaTask.id, { title: "Stolen task" }), null);
  assert.equal(store.updateNote("usr_beta", alphaNote.id, { title: "Stolen note" }), null);
  assert.equal(store.deleteTask("usr_beta", alphaTask.id), false);
  assert.equal(store.deleteNote("usr_beta", alphaNote.id), false);
});

test("member workspace validates and bounds user input", (t) => {
  const store = temporaryStore(t);
  assert.throws(() => store.createTask("usr_member", { title: "x" }), /at least 2 characters/);
  assert.throws(() => store.createNote("usr_member", { title: "" }), /at least 2 characters/);
  const task = store.createTask("usr_member", {
    title: "A valid task",
    detail: "x".repeat(5000),
    priority: "unsupported",
    status: "unsupported",
    dueDate: "not-a-date",
  });
  assert.equal(task.detail.length, 4000);
  assert.equal(task.priority, "normal");
  assert.equal(task.status, "todo");
  assert.equal(task.dueDate, "");
});

test("member dashboard reports only the current personal workspace", (t) => {
  const store = temporaryStore(t);
  store.createTask("usr_member", { title: "Open", status: "todo", dueDate: "2020-01-01" });
  store.createTask("usr_member", { title: "Doing", status: "doing" });
  store.createTask("usr_member", { title: "Done", status: "done" });
  store.createNote("usr_member", { title: "One note" });
  store.createTask("usr_other", { title: "Other user's task" });

  const dashboard = store.dashboard("usr_member");
  assert.deepEqual(dashboard.counts, { open: 2, doing: 1, due: 1, notes: 1 });
  assert.equal(dashboard.tasks.some((task) => task.title.includes("Other")), false);
});

test("frontend and server expose distinct member and operator surfaces", () => {
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const proxy = fs.readFileSync(new URL("../server/lib/hermes-proxy.js", import.meta.url), "utf8");

  assert.match(app, /const MEMBER_NAV/);
  assert.match(app, /const MEMBER_PAGES/);
  assert.match(app, /if \(api\.auth\.canAdmin\) mountMilaDock\(\)/);
  assert.match(api, /\/api\/member\/tasks/);
  assert.match(server, /app\.use\("\/api\/member", member\)/);
  assert.match(server, /\/api\/auth\/mobile\/login/);
  assert.match(server, /\/api\/auth\/mobile\/register/);
  for (const route of ["mcp", "integrations", "kanban", "claude-code", "operations", "skills"]) {
    assert.equal(server.includes(`app.use("/api/${route}", requireOperator`), true);
  }
  assert.match(proxy, /requireRoles\("Creator", "Admin"\)/);
  assert.match(proxy, /hasHermesAccess/);
});
