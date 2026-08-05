// MCP client/host manager: spawns MCP servers over stdio, lists their tools,
// calls tools, and tracks live connections. Uses the official SDK (v1.x).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const SAMPLE = fileURLToPath(new URL("./sample-server.js", import.meta.url));
const AGENTIC = fileURLToPath(new URL("./agentic-os-server.js", import.meta.url));
const OBSIDIAN = fileURLToPath(new URL("./obsidian-server.js", import.meta.url));
const DESKTOP = fileURLToPath(new URL("./desktop-server.js", import.meta.url));
const ERP = fileURLToPath(new URL("./erp-server.js", import.meta.url));

// id -> { client, transport, tools }
const live = new Map();

function splitArgs(value) {
  if (Array.isArray(value)) return value;
  const text = String(value || "").trim();
  if (!text) return [];
  const args = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) { args.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

function erpEnv() {
  return {
    ERP_API_BASE_URL: config.erp.baseUrl,
    ERP_MCP_AUTH_MODE: config.erp.authMode,
    ERP_MCP_BEARER_TOKEN: config.erp.bearerToken,
    ERP_MCP_USERNAME: config.erp.username,
    ERP_MCP_PASSWORD: config.erp.password,
    ERP_MCP_REQUIRE_CONFIRMATION: String(config.erp.requireConfirmation),
    ERP_MCP_MAX_BULK_RECIPIENTS: String(config.erp.maxBulkRecipients),
  };
}

// Resolve the actual spawn command for a stored server record. Built-in kinds are
// resolved at runtime so stored records never carry machine-specific absolute paths.
export function resolveSpawn(server) {
  switch (server.kind) {
    case "sample":
      return { command: process.execPath, args: [SAMPLE], env: {} };
    case "filesystem":
      return { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()], env: {} };
    case "github":
      return { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: config.github } };
    case "agentic":
      return { command: process.execPath, args: [AGENTIC], env: { AGENTIC_OS_URL: process.env.AGENTIC_OS_URL || `http://127.0.0.1:${config.port}`, AGENTIC_OS_TOKEN: config.agenticToken } };
    case "obsidian":
      return { command: process.execPath, args: [OBSIDIAN], env: { OBSIDIAN_VAULT: process.env.OBSIDIAN_VAULT || config.obsidianVault } };
    case "desktop":
      return { command: process.execPath, args: [DESKTOP], env: { NOVA_VOICE_HOME: process.env.NOVA_VOICE_HOME || "C:\\NOVA VOICE", DESKTOP_BRIDGE_PYTHON: process.env.DESKTOP_BRIDGE_PYTHON || "python" } };
    case "erp":
      if (config.erp.pythonModule) {
        return {
          command: config.erp.command || process.env.PYTHON || "python3",
          args: ["-m", config.erp.pythonModule, ...splitArgs(config.erp.args)],
          env: erpEnv(),
        };
      }
      if (config.erp.command) {
        return { command: config.erp.command, args: splitArgs(config.erp.args), env: erpEnv() };
      }
      return {
        command: process.execPath,
        args: [ERP],
        env: erpEnv(),
      };
    default: // custom
      return { command: server.command, args: server.args || [], env: server.env || {} };
  }
}

export function isLive(id) { return live.has(id); }
export function getTools(id) { return live.get(id)?.tools || []; }

export async function connect(server) {
  if (live.has(server.id)) return live.get(server.id);
  const spec = resolveSpawn(server);
  if (!spec.command) throw new Error("No command configured for this server");
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...process.env, ...spec.env },
    stderr: "pipe",
  });
  const client = new Client({ name: "agentic-os", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const res = await client.listTools();
  const tools = (res.tools || []).map((t) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema || null }));
  const entry = { client, transport, tools };
  live.set(server.id, entry);
  return entry;
}

export async function disconnect(id) {
  const e = live.get(id);
  if (!e) return;
  try { await e.client.close(); } catch { /* ignore */ }
  live.delete(id);
}

export async function callTool(id, name, args) {
  const e = live.get(id);
  if (!e) throw new Error("Server is not connected");
  return e.client.callTool({ name, arguments: args || {} });
}

export async function shutdownAll() {
  for (const id of [...live.keys()]) await disconnect(id);
}
