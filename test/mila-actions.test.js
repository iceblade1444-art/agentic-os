import assert from "node:assert/strict";
import test from "node:test";

import { createMilaActions } from "../server/lib/mila-actions.js";

function fixture() {
  const requests = [];
  const notes = [];
  const messages = [];
  let token = 0;
  const kanbanRequest = async (pathname, options = {}) => {
    requests.push({ pathname, options });
    if (pathname.includes("/board")) return {
      columns: [
        { name: "running", tasks: [{ id: "t_run", title: "Live task", status: "running", assignee: "dev", priority: 2 }] },
        { name: "done", tasks: [] },
      ],
    };
    if (options.method === "POST" && /\/tasks\?/.test(pathname)) {
      return { task: { id: "t_new", title: options.body.title, status: options.body.triage ? "triage" : "todo", assignee: options.body.assignee, priority: options.body.priority } };
    }
    if (pathname.includes("/tasks/t_new")) return { id: "t_new", title: "Original title", status: "triage", assignee: "default", priority: 1 };
    return { ok: true };
  };
  const knowledge = {
    status: async () => ({ ready: true, writable: true, notes: 4, folders: 2 }),
    search: async (query) => ({ matches: [{ path: "Roadmap.md", title: "Roadmap", snippet: `Found ${query}` }] }),
    read: async (path) => ({ path, title: "Roadmap", content: "Agentic OS roadmap" }),
    create: async (path, content, context) => {
      notes.push({ mode: "create", path, content, context });
      return { path, title: "Voice note", size: content.length };
    },
    append: async (path, content, context) => {
      notes.push({ mode: "append", path, content, context });
      return { path, title: "Voice note", size: content.length };
    },
  };
  const sessions = [{ id: "claude_main", title: "Agentic OS development", status: "ready", workdir: "/app/work/agentic-os", updatedAt: 1 }];
  const claude = {
    status: async () => ({ ready: true }), listSessions: () => sessions,
    getSession: (id) => sessions.find((item) => item.id === id),
    createSession: () => { throw new Error("should reuse Agentic OS session"); },
    message: async (id, input) => { messages.push({ id, input }); return { id, status: "ready" }; },
  };
  return {
    requests, notes, messages,
    actions: createMilaActions({
      kanbanRequest, knowledge, claude, board: "agentic-os",
      hermesStatus: async () => ({ ready: true, status: 200 }),
      makeToken: () => `confirm_${++token}`,
    }),
  };
}

test("MILA reads live Agentic OS status and Kanban tasks without confirmation", async () => {
  const { actions } = fixture();
  const status = await actions.call("get_system_status", {}, { actor: "Creator" });
  assert.equal(status.hermes.ready, true);
  assert.equal(status.kanban.total, 1);
  assert.equal(status.obsidian.notes, 4);
  assert.equal(status.claude.ready, true);

  const board = await actions.call("list_kanban_tasks", { status: "running", assignee: "dev" }, { actor: "Creator" });
  assert.equal(board.count, 1);
  assert.equal(board.tasks[0].id, "t_run");
});

test("MILA write actions require a single-use confirmation and preserve the staged payload", async () => {
  const { actions, requests } = fixture();
  const staged = await actions.call("create_kanban_task", {
    title: "Original title", body: "Definition of done", initialStatus: "triage", priority: 1,
  }, { actor: "Creator" });
  assert.equal(staged.confirmationRequired, true);
  assert.equal(requests.length, 0);

  const result = await actions.call("create_kanban_task", {
    title: "Changed after confirmation", confirmationToken: staged.confirmationToken,
  }, { actor: "Creator" });
  assert.equal(result.ok, true);
  const create = requests.find((item) => item.options.method === "POST" && item.pathname.includes("/tasks?"));
  assert.equal(create.options.body.title, "Original title");
  await assert.rejects(
    actions.call("create_kanban_task", { confirmationToken: staged.confirmationToken }, { actor: "Creator" }),
    /Confirmation expired/,
  );
});

test("MILA writes Obsidian and starts Claude only after explicit confirmation", async () => {
  const { actions, notes, messages } = fixture();
  const noteStage = await actions.call("write_obsidian_note", {
    mode: "append", path: "MILA/Voice.md", content: "Confirmed note",
  }, { actor: "Creator" });
  assert.equal(notes.length, 0);
  await actions.call("write_obsidian_note", { confirmationToken: noteStage.confirmationToken }, { actor: "Creator" });
  assert.deepEqual(notes[0], {
    mode: "append", path: "MILA/Voice.md", content: "Confirmed note",
    context: { actor: "Creator", source: "mila-live" },
  });

  const claudeStage = await actions.call("ask_claude_code", {
    title: "Review", request: "Inspect the Agentic OS voice bridge", mode: "plan",
  }, { actor: "Creator" });
  assert.equal(messages.length, 0);
  const started = await actions.call("ask_claude_code", { confirmationToken: claudeStage.confirmationToken }, { actor: "Creator" });
  assert.equal(started.sessionId, "claude_main");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages[0].input.permissionMode, "plan");
  assert.match(messages[0].input.text, /voice bridge/);
});

test("MILA tool declarations expose all four Agentic OS control surfaces", async () => {
  const source = await import("../assets/js/mila-tools.js");
  const names = source.MILA_TOOLS.map((tool) => tool.name);
  for (const name of ["delegate_to_hermes", "list_kanban_tasks", "search_obsidian_notes", "ask_claude_code"]) {
    assert.ok(names.includes(name), `${name} must be available to Gemini Live`);
  }
});
