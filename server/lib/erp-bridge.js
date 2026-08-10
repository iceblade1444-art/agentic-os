// Shared access to the Milana ERP MCP server.
//
// MILA's action layer already talks to ERP for conversational questions; the day
// planner needs the same live numbers without duplicating the connect-and-parse
// dance. Every call is defensive: a missing ERP server degrades the briefing, it
// never fails the personal dashboard.

import { db } from "../store.js";
import * as mcpManager from "../mcp/manager.js";

const bounded = (value, max) => String(value ?? "").trim().slice(0, max);

function findServer(store) {
  return store.mcp.list().find((item) => item.id === "mcp_erp" || item.kind === "erp" || item.name === "milana-erp");
}

export function createErpBridge(options = {}) {
  const store = options.db || db;
  const mcp = options.mcpManager || mcpManager;

  async function call(tool, args = {}) {
    const server = findServer(store);
    if (!server) throw Object.assign(new Error("ERP MCP server is not registered"), { status: 404 });
    if (!mcp.isLive(server.id)) {
      const connected = await mcp.connect(server);
      store.mcp.update(server.id, { status: "active", tools: connected.tools });
    }
    const result = await mcp.callTool(server.id, tool, args);
    const text = result?.content?.find((item) => item.type === "text")?.text || "{}";
    try { return JSON.parse(text); } catch { return { ok: true, text }; }
  }

  const safeCall = (tool, args = {}) => call(tool, args)
    .catch((error) => ({ ok: false, tool, error: { message: bounded(error.message, 200) } }));

  return { call, safeCall, available: () => !!findServer(store) };
}

export const erpBridge = createErpBridge();
