import crypto from "node:crypto";

import { config } from "../config.js";
import { db } from "../store.js";
import { claudeCode } from "./claude-code.js";
import { hermesDashboardStatus } from "./hermes-proxy.js";
import { hermesKanbanRequest, kanbanPath } from "./hermes-kanban.js";
import { knowledge } from "./knowledge.js";
import * as mcpManager from "../mcp/manager.js";

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const WRITE_ACTIONS = new Set([
  "create_kanban_task", "delegate_to_hermes", "write_obsidian_note", "ask_claude_code", "call_mcp_tool",
]);
const STATUSES = new Set(["triage", "todo", "ready"]);
const PROFILES = new Set(["default", "scout", "scribe", "reach", "dev"]);

const bounded = (value, max) => String(value ?? "").trim().slice(0, max);
const integer = (value, min, max, fallback = min) => Math.max(min, Math.min(max, Number.parseInt(value, 10) || fallback));
const taskPath = (id, suffix = "", board = config.hermesKanbanBoard) => kanbanPath(`/tasks/${encodeURIComponent(id)}${suffix}`, board);

function boardTasks(board) {
  return (board?.columns || []).flatMap((column) => column.tasks || []);
}

function publicTask(task = {}) {
  return {
    id: task.id, title: task.title, status: task.status, assignee: task.assignee,
    priority: Number(task.priority) || 0, summary: bounded(task.latest_summary || task.summary || task.result, 600),
  };
}

function publicMcpTool(server, tool = {}) {
  return {
    serverId: server.id,
    server: server.name,
    kind: server.kind,
    status: mcpManager.isLive(server.id) ? "active" : (server.status === "error" ? "error" : "stopped"),
    name: tool.name,
    description: bounded(tool.description, 600),
    inputSchema: tool.inputSchema || null,
  };
}

function actionSummary(name, args) {
  if (name === "create_kanban_task") return `Create Kanban task “${bounded(args.title, 120)}”`;
  if (name === "delegate_to_hermes") return `Send “${bounded(args.title || args.goal, 120)}” to Hermes`;
  if (name === "write_obsidian_note") return `${args.mode === "append" ? "Append to" : "Create"} Obsidian note “${bounded(args.path, 160)}”`;
  if (name === "ask_claude_code") return `Start Claude Workspace task “${bounded(args.title || args.request, 120)}”`;
  if (name === "call_mcp_tool") return `Call MCP tool “${bounded(args.tool, 120)}” on “${bounded(args.server, 120)}”`;
  return "Run Agentic OS action";
}

function cleanMutationArgs(name, args = {}) {
  if (name === "create_kanban_task") return {
    title: bounded(args.title, 240), body: bounded(args.body, 20000),
    initialStatus: STATUSES.has(args.initialStatus) ? args.initialStatus : "triage",
    assignee: PROFILES.has(args.assignee) ? args.assignee : "default",
    priority: integer(args.priority, 0, 3, 0),
  };
  if (name === "delegate_to_hermes") return {
    title: bounded(args.title || args.goal, 240), goal: bounded(args.goal, 20000),
    priority: integer(args.priority, 0, 3, 1),
  };
  if (name === "write_obsidian_note") return {
    mode: args.mode === "append" ? "append" : "create",
    path: bounded(args.path, 300), content: bounded(args.content, 100000),
  };
  if (name === "ask_claude_code") return {
    title: bounded(args.title || args.request, 120), request: bounded(args.request, 30000),
    sessionId: bounded(args.sessionId, 160), mode: args.mode === "edit" ? "edit" : "plan",
  };
  if (name === "call_mcp_tool") return {
    server: bounded(args.server || args.serverId, 160),
    tool: bounded(args.tool || args.name, 160),
    args: args.args && typeof args.args === "object" && !Array.isArray(args.args) ? args.args : {},
  };
  return {};
}

function requireFields(name, args) {
  if (name === "create_kanban_task" && !args.title) throw Object.assign(new Error("Task title is required"), { status: 400 });
  if (name === "delegate_to_hermes" && !args.goal) throw Object.assign(new Error("Hermes task goal is required"), { status: 400 });
  if (name === "write_obsidian_note" && (!args.path || !args.content)) throw Object.assign(new Error("Note path and content are required"), { status: 400 });
  if (name === "ask_claude_code" && !args.request) throw Object.assign(new Error("Claude request is required"), { status: 400 });
  if (name === "call_mcp_tool" && (!args.server || !args.tool)) throw Object.assign(new Error("MCP server and tool are required"), { status: 400 });
}

export function createMilaActions(options = {}) {
  const kanbanRequest = options.kanbanRequest || hermesKanbanRequest;
  const boardName = options.board || config.hermesKanbanBoard;
  const library = options.knowledge || knowledge;
  const claude = options.claude || claudeCode;
  const hermesStatus = options.hermesStatus || hermesDashboardStatus;
  const now = options.now || Date.now;
  const makeToken = options.makeToken || (() => crypto.randomBytes(24).toString("base64url"));
  const pending = new Map();

  function cleanupConfirmations() {
    const time = now();
    for (const [token, value] of pending) if (value.expiresAt <= time) pending.delete(token);
  }

  function stage(name, args, actor) {
    cleanupConfirmations();
    const token = makeToken();
    const summary = actionSummary(name, args);
    pending.set(token, { name, args, actor, summary, expiresAt: now() + CONFIRMATION_TTL_MS });
    return { confirmationRequired: true, confirmationToken: token, summary, expiresInSeconds: CONFIRMATION_TTL_MS / 1000 };
  }

  function consume(name, token, actor) {
    cleanupConfirmations();
    const value = pending.get(token);
    pending.delete(token);
    if (!value || value.name !== name || value.actor !== actor || value.expiresAt <= now()) {
      throw Object.assign(new Error("Confirmation expired or does not match this action"), { status: 409 });
    }
    return value.args;
  }

  async function createTask(args, orchestrate = false) {
    const initialStatus = orchestrate ? "triage" : args.initialStatus;
    const assignee = initialStatus === "triage" ? "default" : args.assignee;
    const created = await kanbanRequest(kanbanPath("/tasks", boardName), {
      method: "POST",
      body: {
        title: args.title, body: orchestrate ? args.goal : (args.body || null), assignee,
        priority: args.priority, triage: initialStatus === "triage", workspace_kind: "scratch", max_runtime_seconds: 3600,
      },
    });
    const id = created.task?.id;
    if (id && initialStatus === "ready") {
      await kanbanRequest(taskPath(id, "", boardName), { method: "PATCH", body: { status: "ready" } });
      await kanbanRequest(kanbanPath("/dispatch?max=4", boardName), { method: "POST", body: {} }).catch(() => {});
    }
    let orchestration = null;
    if (id && orchestrate) {
      orchestration = await kanbanRequest(taskPath(id, "/decompose", boardName), { method: "POST", body: {} })
        .then(() => "planning_started").catch((error) => `queued: ${bounded(error.message, 200)}`);
      await kanbanRequest(kanbanPath("/dispatch?max=4", boardName), { method: "POST", body: {} }).catch(() => {});
    }
    const detail = id ? await kanbanRequest(taskPath(id, "", boardName)).catch(() => created.task) : created.task || created;
    return { ok: true, action: orchestrate ? "delegate_to_hermes" : "create_kanban_task", task: publicTask(detail?.task || detail), orchestration };
  }

  async function executeWrite(name, args, context) {
    if (name === "create_kanban_task") return createTask(args, false);
    if (name === "delegate_to_hermes") return createTask(args, true);
    if (name === "write_obsidian_note") {
      const writeContext = { actor: context.actor, source: "mila-live" };
      const note = args.mode === "append"
        ? await library.append(args.path, args.content, writeContext)
        : await library.create(args.path, args.content, writeContext);
      return { ok: true, action: name, note: { path: note.path, title: note.title, bytes: note.size } };
    }
    if (name === "ask_claude_code") {
      const sessions = claude.listSessions();
      let session = args.sessionId ? claude.getSession(args.sessionId) : null;
      if (!session) session = sessions.find((item) => /agentic os/i.test(item.title)) || sessions[0];
      if (!session) session = claude.createSession({ title: args.title || "MILA coding task" });
      const run = claude.message(session.id, {
        text: args.request, permissionMode: args.mode === "edit" ? "acceptEdits" : "plan",
        effort: "high", maxTurns: args.mode === "edit" ? 20 : 10,
      });
      Promise.resolve(run).catch((error) => console.error(`[mila] Claude task ${session.id} failed:`, error.message));
      return { ok: true, action: name, status: "started", sessionId: session.id, title: session.title, mode: args.mode };
    }
    if (name === "call_mcp_tool") {
      const server = db.mcp.list().find((item) => item.id === args.server || item.name === args.server);
      if (!server) throw Object.assign(new Error(`MCP server not found: ${args.server}`), { status: 404 });
      if (!mcpManager.isLive(server.id)) {
        const connected = await mcpManager.connect(server);
        db.mcp.update(server.id, { status: "active", tools: connected.tools });
      }
      const result = await mcpManager.callTool(server.id, args.tool, args.args || {});
      return {
        ok: true,
        action: name,
        server: { id: server.id, name: server.name, kind: server.kind },
        tool: args.tool,
        result,
      };
    }
    throw Object.assign(new Error("Unsupported MILA write action"), { status: 400 });
  }

  async function executeRead(name, args, context) {
    if (name === "get_erp_business_context") {
      const server = db.mcp.list().find((item) => item.id === "mcp_erp" || item.kind === "erp" || item.name === "milana-erp");
      if (!server) throw Object.assign(new Error("ERP MCP server is not registered"), { status: 404 });
      if (!mcpManager.isLive(server.id)) {
        const connected = await mcpManager.connect(server);
        db.mcp.update(server.id, { status: "active", tools: connected.tools });
      }
      const limit = integer(args.limit, 1, 100, 25);
      const callTool = async (tool, toolArgs = {}) => {
        const result = await mcpManager.callTool(server.id, tool, toolArgs);
        const text = result?.content?.find((item) => item.type === "text")?.text || "{}";
        try { return JSON.parse(text); } catch { return { ok: true, text }; }
      };
      const [me, production, control, inventory, finishedGoods, finance] = await Promise.all([
        callTool("erp_me"),
        callTool("erp_active_production", { limit }),
        callTool("erp_business_control", { limit }),
        callTool("erp_inventory_status"),
        callTool("erp_finished_goods_stock", { limit: Math.max(limit, 50) }),
        callTool("erp_finance_summary").catch((error) => ({ ok: false, error: { message: error.message } })),
      ]);
      return {
        source_policy: "Answer ERP business questions only from these live ERP tool results. If a needed field is missing, say the ERP data is missing instead of guessing. For finished-goods / ready-product warehouse questions, use finished_goods_stock only. The exact ready-stock count is finished_goods_stock.total_pieces or finished_goods_stock.answer_hints.ready_goods_total_pieces from /warehouse-stock and /warehouse-map. Never use production.production_output, cutting_output, sewing_output, packaging_output, GM summary, material inventory or old conversation memory as finished-goods warehouse stock.",
        erp_user: me?.data || me,
        production: production?.data || production,
        business_control: control?.data || control,
        cutting_department: control?.data?.cutting_department || null,
        material_inventory: inventory?.data || inventory,
        finished_goods_stock: finishedGoods?.data || finishedGoods,
        finance: finance?.data || finance,
        answer_hints: {
          ...(control?.data?.answer_hints || {}),
          finished_goods_stock: finishedGoods?.data?.answer_hints || null,
        },
      };
    }
    if (name === "list_mcp_tools") {
      const servers = db.mcp.list();
      return {
        servers: servers.map((server) => ({
          id: server.id,
          name: server.name,
          kind: server.kind,
          desc: server.desc || "",
          status: mcpManager.isLive(server.id) ? "active" : (server.status === "error" ? "error" : "stopped"),
          tools: mcpManager.isLive(server.id) ? mcpManager.getTools(server.id).map((tool) => publicMcpTool(server, tool)) : [],
        })),
        tools: servers.flatMap((server) => (mcpManager.isLive(server.id) ? mcpManager.getTools(server.id) : [])
          .map((tool) => publicMcpTool(server, tool))),
      };
    }
    if (name === "get_system_status") {
      const [board, vault, claudeState, hermes] = await Promise.all([
        kanbanRequest(kanbanPath("/board", boardName)), library.status(), claude.status({ probe: false }), hermesStatus(),
      ]);
      const tasks = boardTasks(board);
      const counts = Object.fromEntries((board.columns || []).map((column) => [column.name, (column.tasks || []).length]));
      return {
        hermes: { ready: !!hermes.ready, status: hermes.status || 0 },
        kanban: { total: tasks.length, counts },
        obsidian: { ready: !!vault.ready, writable: !!vault.writable, notes: vault.notes, folders: vault.folders },
        claude: { ready: !!claudeState.ready, sessions: claude.listSessions().length, error: claudeState.error || "" },
      };
    }
    if (name === "list_kanban_tasks") {
      const board = await kanbanRequest(kanbanPath("/board", boardName));
      const status = bounded(args.status, 30);
      const assignee = bounded(args.assignee, 64);
      const query = bounded(args.query, 200).toLowerCase();
      const tasks = boardTasks(board).filter((task) => (!status || task.status === status)
        && (!assignee || task.assignee === assignee)
        && (!query || `${task.title} ${task.latest_summary || ""}`.toLowerCase().includes(query)));
      return { count: tasks.length, tasks: tasks.slice(0, 20).map(publicTask) };
    }
    if (name === "get_kanban_task") {
      const id = bounded(args.id, 160);
      if (!id) throw Object.assign(new Error("Task id is required"), { status: 400 });
      const result = await kanbanRequest(taskPath(id, "", boardName));
      return { task: publicTask(result.task || result) };
    }
    if (name === "search_obsidian_notes") {
      const query = bounded(args.query, 300);
      if (!query) throw Object.assign(new Error("Search query is required"), { status: 400 });
      const result = await library.search(query, { actor: context.actor, source: "mila-live", limit: integer(args.limit, 1, 10, 5) });
      return { query, matches: (result.matches || []).map((item) => ({ path: item.path, title: item.title, snippet: bounded(item.snippet, 500) })) };
    }
    if (name === "read_obsidian_note") {
      const path = bounded(args.path, 300);
      if (!path) throw Object.assign(new Error("Note path is required"), { status: 400 });
      const note = await library.read(path, { actor: context.actor, source: "mila-live" });
      return { path: note.path, title: note.title, content: bounded(note.content, 12000) };
    }
    if (name === "list_claude_sessions") {
      return { sessions: claude.listSessions().slice(0, 12).map((item) => ({ id: item.id, title: item.title, status: item.status, workdir: item.workdir, updatedAt: item.updatedAt })) };
    }
    throw Object.assign(new Error("Unsupported MILA action"), { status: 400 });
  }

  async function call(name, args = {}, context = {}) {
    const action = bounded(name, 80);
    const actor = bounded(context.actor || "Creator", 120);
    if (WRITE_ACTIONS.has(action)) {
      const token = bounded(args.confirmationToken, 200);
      if (token) return executeWrite(action, consume(action, token, actor), { actor });
      const clean = cleanMutationArgs(action, args);
      requireFields(action, clean);
      return stage(action, clean, actor);
    }
    return executeRead(action, args, { actor });
  }

  return { call, pendingCount: () => pending.size };
}

export const milaActions = createMilaActions();
