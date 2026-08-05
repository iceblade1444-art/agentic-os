// Milana ERP MCP bridge. Exposes safe business-read tools and confirmed write
// tools to Agentic OS, Hermes, Claude and MILA through the local MCP host.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const config = {
  baseUrl: (process.env.ERP_API_BASE_URL || "https://erp.milanapremium.uz").replace(/\/$/, ""),
  token: process.env.ERP_MCP_BEARER_TOKEN || "",
  username: process.env.ERP_MCP_USERNAME || "",
  password: process.env.ERP_MCP_PASSWORD || "",
  authMode: process.env.ERP_MCP_AUTH_MODE || "bearer",
  requireConfirmation: process.env.ERP_MCP_REQUIRE_CONFIRMATION !== "false",
  maxBulkRecipients: Math.max(1, Number(process.env.ERP_MCP_MAX_BULK_RECIPIENTS) || 25),
};

let sessionToken = "";

const jsonText = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

function notConfigured(tool) {
  return jsonText({
    ok: false,
    status: "not_configured",
    tool,
    message: "Set ERP_MCP_BEARER_TOKEN or ERP_MCP_USERNAME/ERP_MCP_PASSWORD in Agentic OS .env to enable Milana ERP access.",
    baseUrl: config.baseUrl,
  });
}

function normalizeArgs(args = {}) {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

async function callErpTool(tool, args = {}, preferredMethod = "POST") {
  const auth = await erpAuthHeader();
  if (!auth) return notConfigured(tool);
  const payload = normalizeArgs(args);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: auth,
  };

  const endpoint = `${config.baseUrl}/api/mcp/${encodeURIComponent(tool)}`;
  let response = await fetch(endpoint, {
    method: preferredMethod,
    headers,
    body: preferredMethod === "GET" ? undefined : JSON.stringify(payload),
  });

  if (response.status === 404 || response.status === 405) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value !== "object") query.set(key, String(value));
    }
    response = await fetch(`${endpoint}${query.size ? `?${query}` : ""}`, { method: "GET", headers });
  }

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
  if (!response.ok) {
    return jsonText({
      ok: false,
      status: "erp_error",
      tool,
      httpStatus: response.status,
      message: data.error || data.message || text.slice(0, 600) || "ERP request failed",
    });
  }
  return jsonText({ ok: true, tool, data });
}

async function fetchErpPath(pathname, args = {}) {
  const auth = await erpAuthHeader();
  if (!auth) return notConfigured(pathname);
  const payload = normalizeArgs(args);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== "object") query.set(key, String(value));
  }
  const response = await fetch(`${config.baseUrl}${pathname}${query.size ? `?${query}` : ""}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: auth,
    },
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
  if (!response.ok) return jsonText({ ok: false, status: "erp_error", tool: pathname, httpStatus: response.status, message: data.error || data.message || text.slice(0, 600) || "ERP request failed" });
  return jsonText({ ok: true, data, source: pathname });
}

async function erpAuthHeader() {
  if (config.token) return `${config.authMode === "bearer" ? "Bearer" : config.authMode} ${config.token}`;
  if (!config.username || !config.password) return "";
  if (!sessionToken) sessionToken = await loginErp();
  return `Bearer ${sessionToken}`;
}

async function loginErp() {
  const body = new URLSearchParams();
  body.set("username", config.username);
  body.set("password", config.password);
  const response = await fetch(`${config.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const setCookie = response.headers.get("set-cookie") || "";
  const match = setCookie.match(/(?:^|;\s*)erp_access_token=([^;]+)/) || setCookie.match(/erp_access_token=([^;]+)/);
  let token = match?.[1] ? decodeURIComponent(match[1]) : "";
  if (!token) {
    const text = await response.text();
    try {
      const data = text ? JSON.parse(text) : {};
      token = data.access_token || "";
    } catch {
      token = "";
    }
  }
  if (!response.ok || !token) throw new Error("ERP login failed");
  return token;
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function findStage(item, operation) {
  return (Array.isArray(item?.stages) ? item.stages : []).find((stage) => stage?.operation === operation);
}

function orderBrief(item) {
  return {
    production_order_id: item.production_order_id,
    production_no: item.production_no,
    order_no: item.order_no || item.sales_order_no,
    model_code: item.model_code,
    model_name: item.model_name,
    planned_quantity: item.planned_quantity,
    actual_quantity: item.actual_quantity,
    deadline: item.po_deadline,
  };
}

function sewingFlowName(item) {
  if (item?.current_sewing_flow && typeof item.current_sewing_flow === "object") {
    return item.current_sewing_flow.name || item.current_sewing_flow.code || null;
  }
  if (item?.current_sewing_flow) return String(item.current_sewing_flow);
  const sewing = findStage(item, "sewing");
  if (sewing?.sewing_flow_name || sewing?.sewing_flow_code) return sewing.sewing_flow_name || sewing.sewing_flow_code;
  const factories = Array.isArray(item?.sewing_factories) ? item.sewing_factories : [];
  return factories[0]?.name || factories[0]?.code || null;
}

function businessControlSnapshot(rows, limit = 25) {
  const stageCounts = new Map();
  const flows = new Map();
  const blocked = [];
  const overdue = [];
  const warehouse = [];

  for (const item of Array.isArray(rows) ? rows : []) {
    if (!item || typeof item !== "object") continue;
    const stage = String(item.current_stage || "unknown");
    const stageBucket = stageCounts.get(stage) || { stage, orders: 0, planned_quantity: 0, actual_quantity: 0 };
    stageBucket.orders += 1;
    stageBucket.planned_quantity += numberValue(item.planned_quantity);
    stageBucket.actual_quantity += numberValue(item.actual_quantity);
    stageCounts.set(stage, stageBucket);

    const flow = sewingFlowName(item);
    if (flow) {
      const flowBucket = flows.get(flow) || { flow, orders: 0, planned_quantity: 0, in_progress: 0, waiting: 0, blocked: 0 };
      flowBucket.orders += 1;
      flowBucket.planned_quantity += numberValue(item.planned_quantity);
      const status = String(item.current_stage_status || "").toLowerCase();
      if (["in_progress", "in progress", "active", "running"].includes(status)) flowBucket.in_progress += 1;
      else flowBucket.waiting += 1;
      if (item.is_blocked) flowBucket.blocked += 1;
      flows.set(flow, flowBucket);
    }

    const brief = orderBrief(item);
    if (item.is_blocked) blocked.push({ ...brief, stage, blocked_by: item.blocked_by });
    if (item.po_overdue || (Array.isArray(item.stages) && item.stages.some((stageItem) => stageItem?.overdue))) {
      overdue.push({ ...brief, stage, deadline: item.po_deadline });
    }

    const storage = findStage(item, "storage_transfer");
    if (storage) {
      warehouse.push({
        ...brief,
        warehouse_eta: storage.deadline,
        warehouse_status: storage.status,
        warehouse_overdue: Boolean(storage.overdue),
      });
    }
  }

  const busiest = [...flows.values()].sort((a, b) => (b.planned_quantity - a.planned_quantity) || (b.orders - a.orders));
  const warehouseEta = warehouse.sort((a, b) => String(a.warehouse_eta || "").localeCompare(String(b.warehouse_eta || ""))).slice(0, limit);
  return {
    total_orders: Array.isArray(rows) ? rows.length : 0,
    stage_summary: [...stageCounts.values()].sort((a, b) => b.planned_quantity - a.planned_quantity),
    busiest_sewing_flows: busiest.slice(0, limit),
    blocked_orders: blocked.slice(0, limit),
    overdue_orders: overdue.slice(0, limit),
    warehouse_eta: warehouseEta,
    answer_hints: {
      busiest_sewing_flow: busiest[0] || null,
      next_warehouse_order: warehouseEta[0] || null,
    },
  };
}

async function businessControlTool(args = {}) {
  const response = await fetchErpPath("/api/process-tracking", args);
  const parsed = JSON.parse(response.content[0].text);
  if (!parsed.ok || !Array.isArray(parsed.data)) return response;
  return jsonText({
    ok: true,
    data: businessControlSnapshot(parsed.data, Math.min(100, Math.max(1, Number(args?.limit) || 25))),
    source: "/api/process-tracking",
  });
}

function requireConfirmation(tool, args) {
  if (!config.requireConfirmation || args?.confirmed === true) return null;
  return jsonText({
    ok: false,
    status: "confirmation_required",
    tool,
    message: `Repeat ${tool} with confirmed=true after the user explicitly approves this ERP write action.`,
  });
}

const server = new McpServer({ name: "milana-erp", version: "1.0.0" });

server.registerTool("erp_me", {
  description: "Current authenticated ERP user and permissions.",
  inputSchema: {},
}, async () => callErpTool("erp_me", {}, "GET"));

server.registerTool("erp_gm_summary", {
  description: "GM management dashboard summary: business health, sales, production and key alerts.",
  inputSchema: { from: z.string().optional(), to: z.string().optional() },
}, async (args) => callErpTool("erp_gm_summary", args));

server.registerTool("erp_search", {
  description: "Global ERP search with sensitive fields redacted.",
  inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional() },
}, async (args) => callErpTool("erp_search", args));

server.registerTool("erp_active_production", {
  description: "Active production dashboard status: current orders, stages, blockers and workload.",
  inputSchema: {},
}, async () => callErpTool("erp_active_production", {}, "GET"));

server.registerTool("erp_business_control", {
  description: "Business-control snapshot from process tracking: busiest sewing flows, stage workload, blocked/late orders and warehouse ETA.",
  inputSchema: { limit: z.number().int().min(1).max(100).optional() },
}, async (args) => businessControlTool(args));

server.registerTool("erp_late_orders", {
  description: "Late active orders derived from production dashboard data.",
  inputSchema: { limit: z.number().int().min(1).max(100).optional() },
}, async (args) => callErpTool("erp_late_orders", args));

server.registerTool("erp_inventory_status", {
  description: "Inventory dashboard summary: stock risk, fast moving items and low inventory.",
  inputSchema: {},
}, async () => callErpTool("erp_inventory_status", {}, "GET"));

server.registerTool("erp_finance_summary", {
  description: "Finance dashboard summary when ERP permissions allow it.",
  inputSchema: { from: z.string().optional(), to: z.string().optional() },
}, async (args) => callErpTool("erp_finance_summary", args));

server.registerTool("erp_list_employee_tasks", {
  description: "Task list with safe filters.",
  inputSchema: {
    employee: z.string().optional(),
    status: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
}, async (args) => callErpTool("erp_list_employee_tasks", args));

server.registerTool("erp_send_notification", {
  description: "Confirmed ERP notification send only. Requires confirmed=true.",
  inputSchema: {
    recipientIds: z.array(z.string()).min(1).max(config.maxBulkRecipients),
    message: z.string().min(1),
    confirmed: z.boolean().optional(),
  },
}, async (args) => requireConfirmation("erp_send_notification", args) || callErpTool("erp_send_notification", args));

server.registerTool("erp_create_task", {
  description: "Confirmed ERP task creation only. Requires confirmed=true.",
  inputSchema: {
    title: z.string().min(1),
    assignee: z.string().optional(),
    body: z.string().optional(),
    dueDate: z.string().optional(),
    confirmed: z.boolean().optional(),
  },
}, async (args) => requireConfirmation("erp_create_task", args) || callErpTool("erp_create_task", args));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[milana-erp] MCP server ready on stdio");
