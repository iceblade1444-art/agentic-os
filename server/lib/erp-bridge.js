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

  async function attempt(server, tool, args) {
    if (!mcp.isLive(server.id)) {
      const connected = await mcp.connect(server);
      store.mcp.update(server.id, { status: "active", tools: connected.tools });
    }
    const result = await mcp.callTool(server.id, tool, args);
    const text = result?.content?.find((item) => item.type === "text")?.text || "{}";
    try { return JSON.parse(text); } catch { return { ok: true, text }; }
  }

  // The bridge answers a failed name lookup or a refused connection the same
  // way it answers the ERP itself: as an ok:false result. But "I could not
  // reach the ERP" is not an answer about the business, and one such blip made
  // MILA tell the owner the sewing report was unavailable while the ERP was
  // serving it. These come back rarely and independently, so a second ask
  // settles them; a 403 or a bad tool name repeats identically and is reported.
  function transientFailure(result) {
    if (!result || result.ok !== false) return false;
    const status = Number(result.error?.status_code);
    if (![502, 503, 504].includes(status)) return false;
    return /request failed|connection|timeout|temporarily|unreachable/i.test(String(result.error?.message || ""));
  }

  async function call(tool, args = {}) {
    const server = findServer(store);
    if (!server) throw Object.assign(new Error("ERP MCP server is not registered"), { status: 404 });
    try {
      const result = await attempt(server, tool, args);
      return transientFailure(result) ? await attempt(server, tool, args) : result;
    } catch (error) {
      // A held connection dies with the child process — every deploy restarts
      // the container mid-conversation somewhere. That is a stale pipe, not an
      // ERP answer, so drop the connection and try once on a fresh one. Real
      // errors (bad tool, ERP 403) come back identically on the retry and are
      // reported as themselves.
      if (!/closed|not connected|EPIPE|terminated/i.test(error.message || "")) throw error;
      await mcp.disconnect(server.id).catch(() => {});
      return attempt(server, tool, args);
    }
  }

  const safeCall = (tool, args = {}) => call(tool, args)
    .catch((error) => ({ ok: false, tool, error: { message: bounded(error.message, 200) } }));

  return { call, safeCall, available: () => !!findServer(store) };
}

export const erpBridge = createErpBridge();
