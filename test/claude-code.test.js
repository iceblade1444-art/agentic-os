import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeCodeManager } from "../server/lib/claude-code.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-claude-"));
  const work = path.join(root, "work");
  const data = path.join(root, "data");
  fs.mkdirSync(path.join(work, "demo"), { recursive: true });
  fs.writeFileSync(path.join(work, "demo", "index.js"), "console.log('ready');\n");
  return { root, work, data };
}

test("Claude workspace persists safe sessions and resumable messages", async (t) => {
  const dirs = fixture();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  const calls = [];
  const execute = async (_bin, args) => {
    calls.push(args);
    if (args[0] === "--version") return { ok: true, stdout: "2.1.214 (Claude Code)\n", stderr: "" };
    if (args[0] === "auth") return { ok: true, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "must-not-leak@example.com", subscriptionType: "max" }), stderr: "" };
    return { ok: true, stdout: JSON.stringify({ session_id: "cli_session_1", result: "Implemented and tested.", duration_ms: 2500, num_turns: 2 }), stderr: "" };
  };
  const manager = createClaudeCodeManager({ dataDir: dirs.data, workRoot: dirs.work, execute });

  const status = await manager.status();
  assert.equal(status.ready, true);
  assert.equal(JSON.stringify(status).includes("must-not-leak"), false);

  const created = manager.createSession({ title: "Demo project", workdir: path.join(dirs.work, "demo") });
  const completed = await manager.message(created.id, { text: "Inspect index.js", permissionMode: "plan" });
  assert.equal(completed.status, "ready");
  assert.equal(completed.messages.at(-1).text, "Implemented and tested.");
  assert.equal(manager.listSessions()[0].messageCount, 2);
  assert.ok(calls.at(-1).includes("--permission-mode"));
  assert.ok(calls.at(-1).includes("--model"));
});

test("Claude workspace confines file access to its mounted work root", (t) => {
  const dirs = fixture();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  const manager = createClaudeCodeManager({ dataDir: dirs.data, workRoot: dirs.work });
  const listing = manager.listFiles(path.join(dirs.work, "demo"));
  assert.equal(listing.entries[0].name, "index.js");
  assert.equal(manager.readFile(path.join(dirs.work, "demo"), "index.js").content, "console.log('ready');\n");
  assert.throws(() => manager.resolveWorkspace(path.dirname(dirs.work)), /must stay inside/);
  assert.throws(() => manager.readFile(path.join(dirs.work, "demo"), "../outside.txt"), /escapes/);
});

test("Claude workspace delegates visible work to the Hermes fleet", async (t) => {
  const dirs = fixture();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  const requests = [];
  const kanbanRequest = async (pathname, options = {}) => {
    requests.push({ pathname, options });
    if (pathname.includes("/tasks?") && options.method === "POST") return { task: { id: "t_claude1", ...options.body } };
    return { task: { id: "t_claude1", status: "ready" } };
  };
  const manager = createClaudeCodeManager({ dataDir: dirs.data, workRoot: dirs.work, kanbanRequest });
  const session = manager.createSession({ title: "Research integration", workdir: dirs.work });
  const result = await manager.delegate(session.id, { profile: "scout", body: "Compare primary documentation." });
  assert.equal(result.task.id, "t_claude1");
  assert.equal(result.session.linkedTasks[0].profile, "scout");
  assert.ok(requests.some((request) => request.pathname.includes("/dispatch")));
});

test("Claude desktop UI is wired into the authenticated Agentic OS shell", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const app = fs.readFileSync(path.join(root, "assets/js/app.js"), "utf8");
  const page = fs.readFileSync(path.join(root, "assets/js/pages/claude-code.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "server/index.js"), "utf8");
  const compose = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  assert.match(app, /Claude Workspace/);
  assert.match(page, /claude-conversation/);
  assert.match(page, /data-side="agents"/);
  assert.match(page, /api\.claude\.delegate/);
  assert.match(server, /\/api\/claude-code/);
  assert.match(compose, /\.claude:\/root\/\.claude/);
  assert.match(compose, /agentos-runtime\/work:\/app\/work/);
});
