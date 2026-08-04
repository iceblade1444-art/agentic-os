// Milana ERP MCP bridge. Exposes safe business-read tools and confirmed write
// tools to Agentic OS, Hermes, Claude and MILA through the local MCP host.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const config = {
  baseUrl: (process.env.ERP_API_BASE_URL || "https://erp.milanapremium.uz").replace(/\/$/, ""),
  token: process.env.ERP_MCP_BEARER_TOKEN || "",
  authMode: process.env.ERP_MCP_AUTH_MODE || "bearer",
  requireConfirmation: process.env.ERP_MCP_REQUIRE_CONFIRMATION !== "false",
  maxBulkRecipients: Math.max(1, Number(process.env.ERP_MCP_MAX_BULK_RECIPIENTS) || 25),
};

const jsonText = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

function notConfigured(tool) {
  return jsonText({
    ok: false,
    status: "not_configured",
    tool,
    message: "Set ERP_MCP_BEARER_TOKEN in Agentic OS .env to enable Milana ERP access.",
    baseUrl: config.baseUrl,
  });
}

function normalizeArgs(args = {}) {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

async function callErpTool(tool, args = {}, preferredMethod = "POST") {
  if (!config.token) return notConfigured(tool);
  const payload = normalizeArgs(args);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `${config.authMode === "bearer" ? "Bearer" : config.authMode} ${config.token}`,
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
