import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeCodeManager, parseGitHubRepository } from "../server/lib/claude-code.js";

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
  const execute = async (_bin, args, options) => {
    calls.push({ args, options });
    if (args[0] === "--version") return { ok: true, stdout: "2.1.214 (Claude Code)\n", stderr: "" };
    if (args[0] === "auth") return {
      ok: true,
      stdout: JSON.stringify({
        loggedIn: true, authMethod: "claude.ai", email: "must-not-leak@example.com",
        subscriptionType: "max", expiresAt: Date.now() + 60 * 60 * 1000,
      }),
      stderr: "",
    };
    return { ok: true, stdout: JSON.stringify({ session_id: "cli_session_1", result: "Implemented and tested.", duration_ms: 2500, num_turns: 2 }), stderr: "" };
  };
  const manager = createClaudeCodeManager({
    dataDir: dirs.data,
    workRoot: dirs.work,
    baseUrl: "https://api.anthropic.com",
    execute,
  });

  const status = await manager.status();
  assert.equal(status.ready, true);
  assert.equal(JSON.stringify(status).includes("must-not-leak"), false);
  assert.equal(status.authHealth.state, "expiring");
  assert.match(status.authHealth.warning, /72 hours/);

  const created = manager.createSession({ title: "Demo project", workdir: path.join(dirs.work, "demo") });
  const completed = await manager.message(created.id, {
    text: "Inspect index.js", permissionMode: "plan",
    agentContext: "Authoritative Agentic OS workspace context:\nWorkspace: Milana Premium",
  });
  assert.equal(completed.status, "ready");
  assert.equal(completed.messages.at(-1).text, "Implemented and tested.");
  assert.equal(manager.listSessions()[0].messageCount, 2);
  assert.ok(calls.at(-1).args.includes("--permission-mode"));
  assert.ok(calls.at(-1).args.includes("--model"));
  assert.match(calls.at(-1).args[calls.at(-1).args.indexOf("--append-system-prompt") + 1], /Workspace: Milana Premium/);
  assert.equal(calls.at(-1).options.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal("ANTHROPIC_API_KEY" in calls.at(-1).options.env, false);
});

test("Claude OAuth runtime is isolated from the app Anthropic connector", async (t) => {
  const dirs = fixture();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = "app-connector-key";
  process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
  t.after(() => {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = previousBase;
  });
  const calls = [];
  const execute = async (_bin, args, options) => {
    calls.push({ args, options });
    if (args[0] === "--version") return { ok: true, stdout: "2.1.214", stderr: "" };
    return { ok: true, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
  };
  const manager = createClaudeCodeManager({ dataDir: dirs.data, workRoot: dirs.work, baseUrl: "", apiKey: "", execute });
  await manager.status();
  assert.equal("ANTHROPIC_API_KEY" in calls[0].options.env, false);
  assert.equal("ANTHROPIC_BASE_URL" in calls[0].options.env, false);
  assert.equal("CLAUDE_CODE_BASE_URL" in calls[0].options.env, false);
});

test("Claude workspace reports structured CLI errors instead of a false ready state", async (t) => {
  const dirs = fixture();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  const execute = async () => ({
    ok: true,
    stdout: JSON.stringify({ is_error: true, result: "Selected model is unavailable." }),
    stderr: "",
  });
  const manager = createClaudeCodeManager({ dataDir: dirs.data, workRoot: dirs.work, execute });
  const created = manager.createSession({ title: "Model error", workdir: path.join(dirs.work, "demo") });
  const completed = await manager.message(created.id, { text: "Inspect index.js" });
  assert.equal(completed.status, "error");
  assert.equal(completed.messages.at(-1).ok, false);
  assert.equal(completed.messages.at(-1).text, "Selected model is unavailable.");
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

test("Claude workspace imports and fast-forward syncs a bounded GitHub project", async (t) => {
  const dirs = fixture();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  const calls = [];
  const ownership = [];
  const gitExecute = async (_bin, args, options) => {
    calls.push({ args, options });
    if (args[0] === "clone") {
      const target = args.at(-1);
      fs.mkdirSync(path.join(target, ".git", "info"), { recursive: true });
      fs.writeFileSync(path.join(target, "README.md"), "# Imported\n");
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args[0] === "status") return { ok: true, stdout: "## main...origin/main\n", stderr: "" };
    if (args[0] === "remote") return { ok: true, stdout: "https://github.com/acme/product.git\n", stderr: "" };
    if (args[0] === "rev-parse") return { ok: true, stdout: "origin/main\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
  const manager = createClaudeCodeManager({
    dataDir: dirs.data,
    workRoot: dirs.work,
    githubToken: "server-only-token",
    gitExecute,
    applyWorkspaceOwnership: (root) => ownership.push(root),
  });

  const imported = await manager.importProject({ url: "acme/product", branch: "main", folder: "product-app" });
  assert.equal(imported.project.branch, "main");
  assert.equal(imported.project.remote, "https://github.com/acme/product");
  assert.equal(manager.listProjects().find((item) => item.name === "product-app").git, true);
  assert.match(fs.readFileSync(path.join(imported.project.workdir, ".git", "info", "exclude"), "utf8"), /\.agentic-context\//);
  assert.equal(calls[0].args.includes("server-only-token"), false);
  assert.equal(calls[0].options.env.GIT_CONFIG_VALUE_0.includes("server-only-token"), false);
  assert.equal(calls[0].options.env.GIT_CONFIG_KEY_1, "safe.directory");
  assert.equal(calls[0].options.env.GIT_CONFIG_VALUE_1, dirs.work);
  assert.deepEqual(ownership, [imported.project.workdir]);

  const synced = await manager.syncProject(imported.project.workdir);
  assert.equal(synced.project.dirty, false);
  assert.ok(calls.some((call) => call.args[0] === "fetch"));
  assert.ok(calls.some((call) => call.args[0] === "merge" && call.args.includes("origin/main")));
});

test("GitHub project import rejects credentialed and non-GitHub URLs", () => {
  assert.deepEqual(parseGitHubRepository("iceblade1444-art/agentic-os"), {
    owner: "iceblade1444-art",
    repo: "agentic-os",
    cloneUrl: "https://github.com/iceblade1444-art/agentic-os.git",
    webUrl: "https://github.com/iceblade1444-art/agentic-os",
  });
  assert.throws(() => parseGitHubRepository("https://example.com/acme/product"), /Only direct github\.com/);
  assert.throws(() => parseGitHubRepository("https://token@github.com/acme/product"), /Only direct github\.com/);
  assert.throws(() => parseGitHubRepository("https://github.com/acme/product/issues"), /one owner and one repository/);
});

test("Git synchronization refuses to overwrite local project changes", async (t) => {
  const dirs = fixture();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  const repo = path.join(dirs.work, "dirty-project");
  fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  const calls = [];
  const gitExecute = async (_bin, args) => {
    calls.push(args);
    if (args[0] === "status") return { ok: true, stdout: "## main...origin/main\n M src/app.js\n", stderr: "" };
    if (args[0] === "remote") return { ok: true, stdout: "https://github.com/acme/dirty-project.git\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
  const manager = createClaudeCodeManager({ dataDir: dirs.data, workRoot: dirs.work, gitExecute });

  await assert.rejects(() => manager.syncProject(repo), /Commit or discard local changes/);
  assert.equal(calls.some((args) => args[0] === "fetch"), false);
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
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.match(app, /Claude Workspace/);
  assert.match(page, /claude-conversation/);
  assert.match(page, /data-side="agents"/);
  assert.match(page, /api\.claude\.delegate/);
  assert.match(page, /api\.claude\.importProject/);
  assert.match(page, /claudeProjectSync/);
  assert.match(page, /value="fable"/);
  assert.match(page, /value="sonnet" selected/);
  assert.match(server, /\/api\/claude-code/);
  assert.match(compose, /CLAUDE_CONFIG_DIR.*:\/root\/\.claude/);
  assert.match(compose, /CLAUDE_CONFIG_FILE.*:\/root\/\.claude\.json/);
  assert.match(compose, /agentos-runtime\/work:\/app\/work/);
  assert.match(dockerfile, /apk add --no-cache git openssh-client/);
});
