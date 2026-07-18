import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { hermesKanbanRequest, kanbanPath } from "./hermes-kanban.js";

const MAX_SESSIONS = 80;
const MAX_MESSAGES = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ATTACHMENT_BYTES = 700 * 1024;
const SKIP_NAMES = new Set([".git", "node_modules", "build", ".dart_tool", ".agentic-context"]);
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".css", ".dart", ".go", ".h", ".html", ".java", ".js", ".json",
  ".jsx", ".kt", ".md", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".swift", ".toml",
  ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const PROFILES = new Set(["default", "scout", "scribe", "reach", "dev"]);
const running = new Set();

const uid = (prefix) => `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
const bounded = (value, max) => String(value || "").trim().slice(0, max);

function defaultExecute(bin, args, options = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      timeout: options.timeout,
      maxBuffer: 12 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({
      ok: !error,
      code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
      error: error?.message || "",
      stdout: String(stdout || ""),
      stderr: String(stderr || ""),
    }));
  });
}

function safeAuth(raw) {
  try {
    const value = JSON.parse(raw || "{}");
    return {
      loggedIn: value.loggedIn === true,
      authMethod: bounded(value.authMethod, 40),
      apiProvider: bounded(value.apiProvider, 40),
      subscriptionType: bounded(value.subscriptionType, 40),
    };
  } catch {
    return { loggedIn: false, authMethod: "unknown", apiProvider: "", subscriptionType: "" };
  }
}

export function createClaudeCodeManager(options = {}) {
  const dataDir = path.resolve(options.dataDir || config.dataDir);
  const workRoot = path.resolve(options.workRoot || config.claudeCode.workdir);
  const bin = options.bin || config.claudeCode.bin;
  const baseUrl = options.baseUrl || config.claudeCode.baseUrl;
  const defaultModel = options.model || config.claudeCode.model;
  const timeoutMs = options.timeoutMs || config.claudeCode.timeoutMs;
  const rawExecute = options.execute || defaultExecute;
  const execute = (command, args, executeOptions = {}) => rawExecute(command, args, {
    ...executeOptions,
    env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl },
  });
  const kanbanRequest = options.kanbanRequest || hermesKanbanRequest;
  const kanbanBoard = options.kanbanBoard || config.hermesKanbanBoard;
  const file = path.join(dataDir, "claude-code-sessions.json");
  let modelProbe = { checkedAt: 0, ready: null, error: "" };

  function resolveWorkspace(candidate = workRoot) {
    const target = path.resolve(candidate || workRoot);
    const relative = path.relative(workRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw Object.assign(new Error("Workspace must stay inside the configured Claude work root"), { status: 400 });
    }
    return target;
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed.sessions) ? parsed : { sessions: [] };
    } catch {
      return { sessions: [] };
    }
  }

  function save(state) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, file);
  }

  function find(state, id) {
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw Object.assign(new Error("Claude session not found"), { status: 404 });
    return session;
  }

  function publicSession(session, detail = false) {
    const base = {
      id: session.id,
      title: session.title,
      workdir: session.workdir,
      status: running.has(session.id) ? "running" : session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
      linkedTasks: session.linkedTasks || [],
      context: session.context || [],
      lastMessage: session.messages.at(-1)?.text?.slice(0, 180) || "",
    };
    if (detail) base.messages = session.messages;
    return base;
  }

  function listProjects() {
    fs.mkdirSync(workRoot, { recursive: true });
    const children = fs.readdirSync(workRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !SKIP_NAMES.has(entry.name))
      .slice(0, 80)
      .map((entry) => {
        const full = path.join(workRoot, entry.name);
        const stat = fs.statSync(full);
        return { name: entry.name, workdir: full, updatedAt: stat.mtimeMs };
      });
    return [{ name: "Shared workspace", workdir: workRoot, updatedAt: fs.statSync(workRoot).mtimeMs }, ...children];
  }

  function listFiles(workdir, relative = "") {
    const root = resolveWorkspace(workdir);
    const directory = path.resolve(root, relative || ".");
    const withinSession = path.relative(root, directory);
    if (withinSession.startsWith("..") || path.isAbsolute(withinSession)) {
      throw Object.assign(new Error("File path escapes the selected workspace"), { status: 400 });
    }
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !SKIP_NAMES.has(entry.name))
      .slice(0, 160)
      .map((entry) => {
        const full = path.join(directory, entry.name);
        const stat = fs.statSync(full);
        return {
          name: entry.name,
          path: path.relative(root, full).split(path.sep).join("/"),
          type: entry.isDirectory() ? "directory" : "file",
          size: entry.isFile() ? stat.size : null,
          updatedAt: stat.mtimeMs,
        };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
    return { workdir: root, path: path.relative(root, directory).split(path.sep).join("/"), entries };
  }

  function readFile(workdir, relative) {
    const root = resolveWorkspace(workdir);
    const target = path.resolve(root, relative || "");
    const withinSession = path.relative(root, target);
    if (!relative || withinSession.startsWith("..") || path.isAbsolute(withinSession)) {
      throw Object.assign(new Error("File path escapes the selected workspace"), { status: 400 });
    }
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw Object.assign(new Error("Path is not a file"), { status: 400 });
    if (stat.size > MAX_FILE_BYTES) throw Object.assign(new Error("File is too large to preview"), { status: 413 });
    const ext = path.extname(target).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext) && !["Dockerfile", "Makefile", ".gitignore"].includes(path.basename(target))) {
      throw Object.assign(new Error("Binary file preview is not supported"), { status: 415 });
    }
    return { path: relative, size: stat.size, content: fs.readFileSync(target, "utf8") };
  }

  function materializeAttachments(session, attachments = []) {
    const root = resolveWorkspace(session.workdir);
    const output = path.join(root, ".agentic-context");
    let total = 0;
    const saved = [];
    for (const item of attachments.slice(0, 6)) {
      const name = path.basename(bounded(item?.name, 120)).replace(/[^a-zA-Z0-9._-]/g, "_") || "context.txt";
      const raw = String(item?.data || "").replace(/^data:[^,]*,/, "");
      const buffer = Buffer.from(raw, "base64");
      total += buffer.length;
      if (!buffer.length || total > MAX_ATTACHMENT_BYTES) {
        throw Object.assign(new Error("Attached context exceeds the 700 KB limit"), { status: 413 });
      }
      fs.mkdirSync(output, { recursive: true });
      const filename = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${name}`;
      const full = path.join(output, filename);
      fs.writeFileSync(full, buffer);
      saved.push({ name, type: bounded(item?.type, 100), path: path.relative(root, full).split(path.sep).join("/"), size: buffer.length });
    }
    return saved;
  }

  async function status({ probe = false } = {}) {
    fs.mkdirSync(workRoot, { recursive: true });
    const version = await execute(bin, ["--version"], { cwd: workRoot, timeout: 8000 });
    const authResult = version.ok
      ? await execute(bin, ["auth", "status", "--json"], { cwd: workRoot, timeout: 10000 })
      : { ok: false, stdout: "" };
    const auth = safeAuth(authResult.stdout);
    if (probe && version.ok && auth.loggedIn && Date.now() - modelProbe.checkedAt > 10 * 60 * 1000) {
      const result = await execute(bin, [
        "-p", "Reply exactly CLAUDE_CODE_READY. Do not use tools.",
        "--model", defaultModel,
        "--max-turns", "1",
        "--effort", "low",
        "--permission-mode", "plan",
        "--output-format", "json",
      ], { cwd: workRoot, timeout: 45000 });
      let parsed = {};
      try { parsed = JSON.parse(result.stdout || "{}"); } catch {}
      const modelError = bounded(parsed.result || result.stderr || result.error, 500);
      modelProbe = {
        checkedAt: Date.now(),
        ready: result.ok && parsed.is_error !== true,
        error: result.ok && parsed.is_error !== true ? "" : modelError || "Claude model check failed",
      };
    }
    const modelReady = modelProbe.ready !== false;
    return {
      ready: version.ok && auth.loggedIn && modelReady,
      installed: version.ok,
      version: bounded(version.stdout || version.stderr, 120),
      defaultModel,
      model: { name: defaultModel, ...modelProbe },
      workRoot,
      auth,
      runningSessions: [...running],
      checkedAt: Date.now(),
      error: !version.ok
        ? bounded(version.stderr || version.error, 500)
        : !auth.loggedIn
          ? "Claude Code needs authentication"
          : modelProbe.ready === false
            ? modelProbe.error
            : "",
    };
  }

  function listSessions() {
    return load().sessions.map((session) => publicSession(session));
  }

  function getSession(id) {
    return publicSession(find(load(), id), true);
  }

  function createSession(input = {}) {
    const state = load();
    const workdir = resolveWorkspace(input.workdir || workRoot);
    fs.mkdirSync(workdir, { recursive: true });
    const now = Date.now();
    const session = {
      id: uid("claude"),
      title: bounded(input.title, 120) || "New coding task",
      workdir,
      status: "ready",
      cliSessionId: "",
      createdAt: now,
      updatedAt: now,
      messages: [],
      linkedTasks: [],
      context: [],
    };
    state.sessions.unshift(session);
    state.sessions = state.sessions.slice(0, MAX_SESSIONS);
    save(state);
    return publicSession(session, true);
  }

  function removeSession(id) {
    if (running.has(id)) throw Object.assign(new Error("Cannot delete a running Claude session"), { status: 409 });
    const state = load();
    find(state, id);
    state.sessions = state.sessions.filter((item) => item.id !== id);
    save(state);
    return { ok: true, id };
  }

  async function message(id, input = {}) {
    if (running.has(id)) throw Object.assign(new Error("Claude is already working in this session"), { status: 409 });
    const text = bounded(input.text, 30000);
    if (!text) throw Object.assign(new Error("Message is required"), { status: 400 });
    const maxTurns = Math.max(1, Math.min(40, Number(input.maxTurns) || 12));
    const effort = ["low", "medium", "high", "max"].includes(input.effort) ? input.effort : "high";
    const permissionMode = input.permissionMode === "plan" ? "plan" : "acceptEdits";
    const requestedModel = bounded(input.model, 100) || defaultModel;
    const model = /^[a-zA-Z0-9._\-[\]]{1,100}$/.test(requestedModel) ? requestedModel : defaultModel;
    const state = load();
    const session = find(state, id);
    const context = materializeAttachments(session, input.attachments);
    session.context = [...(session.context || []), ...context].slice(-24);
    session.messages.push({ id: uid("msg"), role: "user", text, at: Date.now(), attachments: context });
    session.messages = session.messages.slice(-MAX_MESSAGES);
    session.status = "running";
    session.updatedAt = Date.now();
    save(state);
    running.add(id);

    const contextHint = context.length
      ? `\n\nThe user attached these files inside the workspace:\n${context.map((item) => `- ${item.path}`).join("\n")}`
      : "";
    const args = [
      "-p", `${text}${contextHint}`,
      "--max-turns", String(maxTurns),
      "--effort", effort,
      "--model", model,
      "--permission-mode", permissionMode,
      "--append-system-prompt", "You are Claude Code inside Agentic OS. Work only inside the selected workspace. Keep changes reviewable, run focused verification, and finish with a concise summary of files changed, checks run, and any remaining risk.",
      "--output-format", "json",
    ];
    if (session.cliSessionId) args.push("--resume", session.cliSessionId);

    try {
      const result = await execute(bin, args, { cwd: session.workdir, timeout: timeoutMs });
      let parsed = {};
      try { parsed = JSON.parse(result.stdout || "{}"); } catch {}
      const latest = load();
      const target = find(latest, id);
      target.cliSessionId = bounded(parsed.session_id || target.cliSessionId, 160);
      target.status = result.ok ? "ready" : "error";
      target.updatedAt = Date.now();
      target.messages.push({
        id: uid("msg"),
        role: "assistant",
        text: bounded(parsed.result || result.stderr || result.error || "Claude Code returned no output", 100000),
        at: Date.now(),
        ok: result.ok,
        meta: {
          durationMs: Number(parsed.duration_ms) || null,
          turns: Number(parsed.num_turns) || null,
          costUsd: Number(parsed.total_cost_usd) || null,
        },
      });
      target.messages = target.messages.slice(-MAX_MESSAGES);
      save(latest);
      running.delete(id);
      return publicSession(target, true);
    } catch (error) {
      const latest = load();
      const target = find(latest, id);
      target.status = "error";
      target.updatedAt = Date.now();
      target.messages.push({
        id: uid("msg"), role: "assistant", text: bounded(error.message || "Claude Code failed", 2000),
        at: Date.now(), ok: false,
      });
      target.messages = target.messages.slice(-MAX_MESSAGES);
      save(latest);
      throw error;
    } finally {
      running.delete(id);
    }
  }

  async function delegate(id, input = {}) {
    const state = load();
    const session = find(state, id);
    const profile = PROFILES.has(input.profile) ? input.profile : "default";
    const title = bounded(input.title, 240) || `${session.title} · ${profile}`;
    const body = bounded(input.body, 20000) || bounded(session.messages.filter((item) => item.role === "user").at(-1)?.text, 20000);
    if (!body) throw Object.assign(new Error("Describe the task before delegating it"), { status: 400 });
    const created = await kanbanRequest(kanbanPath("/tasks", kanbanBoard), {
      method: "POST",
      body: {
        title,
        body: `${body}\n\nSource: Claude Workspace session ${session.id}`,
        assignee: profile,
        priority: Math.max(0, Math.min(3, Number(input.priority) || 1)),
        triage: profile === "default",
        workspace_kind: "scratch",
        max_runtime_seconds: 3600,
      },
    });
    const taskId = created.task?.id;
    if (taskId && profile !== "default") {
      await kanbanRequest(kanbanPath(`/tasks/${encodeURIComponent(taskId)}`, kanbanBoard), {
        method: "PATCH", body: { status: "ready" },
      });
    }
    await kanbanRequest(kanbanPath("/dispatch?max=4", kanbanBoard), { method: "POST", body: {} }).catch(() => {});
    if (taskId) {
      session.linkedTasks = [...(session.linkedTasks || []), { id: taskId, profile, title, at: Date.now() }].slice(-30);
      session.messages.push({ id: uid("msg"), role: "agent", agent: profile, text: `Delegated to ${profile}: ${title}`, taskId, at: Date.now() });
      session.updatedAt = Date.now();
      save(state);
    }
    return { task: created.task || created, session: publicSession(session, true) };
  }

  return { status, listProjects, listSessions, getSession, createSession, removeSession, listFiles, readFile, message, delegate, resolveWorkspace };
}

export const claudeCode = createClaudeCodeManager();
