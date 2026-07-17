// "agentic-os" MCP server — exposes Agentic OS itself as MCP tools so an external
// orchestrator (e.g. Hermes, with an OpenAI brain) can drive it: discover/call the
// tools of every connected MCP server, use integrations, run sub-LLM calls, pull
// missions, and report progress back into the dashboard feed.
//
// This is a thin stdio bridge over the Agentic OS REST API (AGENTIC_OS_URL).
// Register it in Hermes' config.yaml under `mcp_servers`. See the README.
//
// stdout is the MCP protocol channel — only console.error (stderr) for logs.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.AGENTIC_OS_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
// Production commonly uses the main AUTH_TOKEN for both the web app and its
// private Hermes bridge. AGENTIC_OS_TOKEN remains available for key separation.
const TOKEN = process.env.AGENTIC_OS_TOKEN || process.env.AUTH_TOKEN || "";

async function api(path, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-Agent-Name": process.env.AGENTIC_OS_ACTOR || "Hermes",
    "X-Agent-Source": "hermes-mcp",
  };
  if (TOKEN) headers.Authorization = "Bearer " + TOKEN;
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}
const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });

const server = new McpServer({ name: "agentic-os", version: "1.0.0" });

server.registerTool("agentic_list_tools",
  { description: "List every tool available across the MCP servers connected in Agentic OS.", inputSchema: {} },
  async () => {
    const servers = await api("/api/mcp/servers");
    const tools = servers.filter((s) => s.status === "active").flatMap((s) => (s.tools || []).map((t) => ({ server: s.name, serverId: s.id, tool: t.name, description: t.description })));
    return text({ tools });
  });

server.registerTool("agentic_call_tool",
  { description: "Call a tool on a connected Agentic OS MCP server. Auto-connects the server if needed.", inputSchema: { server: z.string().describe("MCP server id or name"), tool: z.string(), args: z.record(z.any()).optional() } },
  async ({ server: srv, tool, args }) => {
    const servers = await api("/api/mcp/servers");
    const s = servers.find((x) => x.id === srv || x.name === srv);
    if (!s) throw new Error("server not found: " + srv);
    if (s.status !== "active") await api(`/api/mcp/servers/${s.id}/connect`, { method: "POST" });
    const r = await api(`/api/mcp/servers/${s.id}/call`, { method: "POST", body: { tool, args: args || {} } });
    return text((r.result?.content || []).map((c) => c.text).filter(Boolean).join("\n") || r);
  });

server.registerTool("agentic_list_integrations",
  { description: "List Agentic OS integrations and their connection status.", inputSchema: {} },
  async () => text((await api("/api/integrations")).map((i) => ({ provider: i.provider, connected: i.connected }))));

server.registerTool("agentic_send_slack",
  { description: "Send a message to Slack via the connected Agentic OS integration.", inputSchema: { text: z.string() } },
  async ({ text: t }) => { await api("/api/integrations/slack/send", { method: "POST", body: { text: t } }); return text("sent"); });

server.registerTool("agentic_mila_status",
  { description: "Check the connected MILA voice backend and Gemini Live readiness.", inputSchema: {} },
  async () => text(await api("/api/integrations/mila/status")));

server.registerTool("agentic_mila_connection_code",
  { description: "Create a 10-minute one-time code for connecting the MILA mobile app.", inputSchema: { label: z.string().optional() } },
  async ({ label }) => text(await api("/api/integrations/mila/connection-code", { method: "POST", body: { label: label || "MILA user" } })));

server.registerTool("obsidian_status",
  { description: "Check the shared Agentic OS Obsidian vault, note counts and MCP readiness.", inputSchema: {} },
  async () => text(await api("/api/knowledge/status")));

server.registerTool("obsidian_list_notes",
  { description: "List Markdown notes in the shared Obsidian vault.", inputSchema: { query: z.string().optional() } },
  async ({ query }) => text(await api(`/api/knowledge/notes${query ? `?q=${encodeURIComponent(query)}` : ""}`)));

server.registerTool("obsidian_read_note",
  { description: "Read one Markdown note from the shared Obsidian vault.", inputSchema: { path: z.string() } },
  async ({ path }) => text(await api(`/api/knowledge/notes/read?path=${encodeURIComponent(path)}`)));

server.registerTool("obsidian_search_notes",
  { description: "Full-text search the shared Obsidian vault.", inputSchema: { query: z.string(), limit: z.number().optional() } },
  async ({ query, limit }) => text(await api(`/api/knowledge/search?q=${encodeURIComponent(query)}&limit=${limit || 20}`)));

server.registerTool("obsidian_create_note",
  { description: "Create a Markdown note in the shared Obsidian vault. Confirm the intended write with the user first.", inputSchema: { path: z.string(), content: z.string() } },
  async ({ path, content }) => text(await api("/api/knowledge/notes", { method: "POST", body: { path, content } })));

server.registerTool("obsidian_append_note",
  { description: "Append durable knowledge to a Markdown note. Confirm the intended write with the user first.", inputSchema: { path: z.string(), text: z.string() } },
  async ({ path, text: value }) => text(await api("/api/knowledge/notes/append", { method: "POST", body: { path, text: value } })));

server.registerTool("agentic_run_llm",
  { description: "Run a one-shot LLM completion (sub-agent) through the Agentic OS model proxy.", inputSchema: { instructions: z.string().optional(), input: z.string(), model: z.string().optional() } },
  async ({ instructions, input, model }) => { const r = await api("/api/llm/complete", { method: "POST", body: { system: instructions, prompt: input, model } }); return text(r.text || r); });

server.registerTool("list_missions",
  { description: "List missions in Agentic OS. Use to pull pending missions to work on.", inputSchema: {} },
  async () => text(await api("/api/missions")));

server.registerTool("get_mission",
  { description: "Get a mission and its full event log.", inputSchema: { mission_id: z.string() } },
  async ({ mission_id }) => text(await api("/api/missions/" + mission_id)));

server.registerTool("mission_report",
  { description: "Post a progress note to a mission's live feed (appears in the Agentic OS dashboard).", inputSchema: { mission_id: z.string(), message: z.string() } },
  async ({ mission_id, message }) => { await api(`/api/missions/${mission_id}/events`, { method: "POST", body: { type: "tool_result", message } }); return text("reported"); });

server.registerTool("mission_complete",
  { description: "Mark a mission complete with a summary.", inputSchema: { mission_id: z.string(), summary: z.string() } },
  async ({ mission_id, summary }) => { await api(`/api/missions/${mission_id}/events`, { method: "POST", body: { type: "complete", message: summary, status: "completed" } }); return text("completed"); });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[agentic-os] MCP bridge ready → " + BASE);
