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
// id -> Promise<entry>: the spawn in flight, shared by everyone who asks
// while it runs. Without it, every caller that finds the map empty starts its
// own bridge — the ERP digest fires three calls at once, the ERP page nine —
// and all but the last one to finish become orphans that live for days,
// while the one that "won" turned out deaf more than once.
const pending = new Map();
// A bridge that has not answered in this long has stopped listening. The
// SDK's own default is a full minute, which is how a morning brief spent
// sixty seconds per tool waiting on a corpse and shipped with no ERP at all.
export const CALL_TIMEOUT_MS = 20000;
const REQUEST_TIMEOUT = -32001;

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

function erpEnv(erp = config.erp) {
  return {
    ERP_API_BASE_URL: erp.baseUrl,
    ERP_MCP_AUTH_MODE: erp.authMode,
    ERP_MCP_BEARER_TOKEN: erp.bearerToken,
    ERP_MCP_USERNAME: erp.username,
    ERP_MCP_PASSWORD: erp.password,
    ERP_MCP_REQUIRE_CONFIRMATION: String(erp.requireConfirmation),
    ERP_MCP_MAX_BULK_RECIPIENTS: String(erp.maxBulkRecipients),
  };
}

// Resolve the actual spawn command for a stored server record. Built-in kinds are
// resolved at runtime so stored records never carry machine-specific absolute paths.
export function resolveSpawn(server, erp = config.erp) {
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
      if (erp.pythonModule) {
        return {
          command: erp.command || process.env.PYTHON || "python3",
          args: ["-m", erp.pythonModule, ...splitArgs(erp.args)],
          env: erpEnv(erp),
        };
      }
      if (erp.command) {
        return { command: erp.command, args: splitArgs(erp.args), env: erpEnv(erp) };
      }
      return {
        command: process.execPath,
        args: [ERP],
        env: erpEnv(erp),
      };
    default: // custom
      return { command: server.command, args: server.args || [], env: server.env || {} };
  }
}

export function isLive(id) { return live.has(id); }
export function getTools(id) { return live.get(id)?.tools || []; }

export async function connect(server) {
  if (live.has(server.id)) return live.get(server.id);
  if (pending.has(server.id)) return pending.get(server.id);
  const attempt = spawn(server).finally(() => pending.delete(server.id));
  pending.set(server.id, attempt);
  return attempt;
}

// Forget a bridge and make sure its process goes with it: an entry that is
// merely forgotten leaves a child behind, and the child keeps its ERP
// session open for nobody.
function evict(id, entry) {
  if (live.get(id) === entry) live.delete(id);
  Promise.resolve().then(() => entry.client.close()).catch(() => {});
}

async function spawn(server) {
  const spec = resolveSpawn(server);
  if (!spec.command) throw new Error("No command configured for this server");
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...process.env, ...spec.env },
    stderr: "pipe",
  });
  const client = new Client({ name: "agentic-os", version: "1.0.0" }, { capabilities: {} });
  // A piped stderr must be drained. Otherwise enough diagnostics can fill the
  // OS pipe and suspend an otherwise healthy MCP child.
  transport.stderr?.resume();
  let res;
  try {
    await client.connect(transport, { timeout: 8000 });
    res = await client.listTools({}, { timeout: 8000 });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  const tools = (res.tools || []).map((t) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema || null }));
  const entry = { client, transport, tools };
  // A child that dies has to take its entry with it. Without this the map
  // keeps a corpse: isLive() stays true, so nothing ever reconnects, and every
  // later call waits out its own timeout instead. That is exactly how the ERP
  // panel filled with "-32001 Request timed out" on every tool while the ERP
  // itself was answering normally — the bridge process was gone and the app
  // had no way to notice.
  const drop = () => evict(server.id, entry);
  client.onclose = drop;
  client.onerror = drop;
  live.set(server.id, entry);
  return entry;
}

export async function disconnect(id) {
  const e = live.get(id);
  if (!e) return;
  try { await e.client.close(); } catch { /* ignore */ }
  live.delete(id);
}

export async function callTool(id, name, args, { timeout = CALL_TIMEOUT_MS } = {}) {
  const e = live.get(id);
  if (!e) throw new Error("Server is not connected");
  try {
    return await e.client.callTool({ name, arguments: args || {} }, undefined, { timeout });
  } catch (error) {
    // A process that is alive but no longer answers looks exactly like a slow
    // one, right up to the timeout. After it, treat the bridge as gone: drop
    // it, kill it, and let the next call start a fresh one — a second of
    // reconnect against a day of silence.
    if (error?.code === REQUEST_TIMEOUT) evict(id, e);
    throw error;
  }
}

export async function shutdownAll() {
  for (const id of [...live.keys()]) await disconnect(id);
}

export const internals = { live, pending, evict };
