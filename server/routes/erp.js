import { Router } from "express";
import { config } from "../config.js";
import { db } from "../store.js";
import * as mcp from "../mcp/manager.js";

const r = Router();
const ERP_ID = "mcp_erp";
const READ_TOOLS = [
  ["erp_me", {}],
  ["erp_gm_summary", {}],
  ["erp_active_production", {}],
  ["erp_business_control", { limit: 25 }],
  ["erp_late_orders", { limit: 12 }],
  ["erp_inventory_status", {}],
  ["erp_finance_summary", {}],
  ["erp_list_employee_tasks", { limit: 20 }],
];

function parseMcp(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text || "";
  try { return JSON.parse(text); } catch { return { ok: true, text }; }
}

async function ensureConnected() {
  const server = db.mcp.get(ERP_ID);
  if (!server) throw new Error("Milana ERP MCP server is not registered");
  if (!mcp.isLive(ERP_ID)) {
    const { tools } = await mcp.connect(server);
    db.mcp.update(ERP_ID, { status: "active", tools });
  }
  return db.mcp.get(ERP_ID);
}

async function call(tool, args = {}) {
  await ensureConnected();
  return parseMcp(await mcp.callTool(ERP_ID, tool, args));
}

async function safeCall(tool, args) {
  try { return await call(tool, args); } catch (error) { return { ok: false, status: "agentic_os_error", message: error.message }; }
}

r.get("/", async (req, res) => {
  const configured = !!config.erp.bearerToken;
  const server = db.mcp.get(ERP_ID);
  const snapshot = {
    ok: true,
    configured,
    baseUrl: config.erp.baseUrl,
    server: {
      id: ERP_ID,
      name: server?.name || "milana-erp",
      status: mcp.isLive(ERP_ID) ? "active" : (server?.status || "stopped"),
      tools: mcp.isLive(ERP_ID) ? mcp.getTools(ERP_ID) : (server?.tools || []),
    },
    cards: {},
    errors: {},
    updatedAt: Date.now(),
  };

  if (!configured) {
    snapshot.errors.configuration = "ERP_MCP_BEARER_TOKEN is not set on the Agentic OS server.";
    return res.json(snapshot);
  }

  const entries = await Promise.all(READ_TOOLS.map(async ([tool, args]) => [tool, await safeCall(tool, args)]));
  for (const [tool, result] of entries) {
    if (result?.ok === false) snapshot.errors[tool] = result.message || result.status || "ERP tool failed";
    snapshot.cards[tool] = result?.data ?? result;
  }
  snapshot.server.status = mcp.isLive(ERP_ID) ? "active" : snapshot.server.status;
  snapshot.server.tools = mcp.isLive(ERP_ID) ? mcp.getTools(ERP_ID) : snapshot.server.tools;
  res.json(snapshot);
});

r.post("/tool", async (req, res) => {
  const { tool, args } = req.body || {};
  if (!tool || !String(tool).startsWith("erp_")) return res.status(400).json({ error: "ERP tool name is required" });
  const result = await call(tool, args || {});
  res.json({ ok: true, result });
});

export default r;
