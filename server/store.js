// Tiny JSON-file datastore (no native deps). Holds the server-authoritative
// resources: MCP server definitions and integration connections.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { hardenRuntimeFile } from "./lib/runtime-files.js";

const dir = path.resolve(config.dataDir);
const file = path.join(dir, "db.json");

// Built-in servers store only a `kind`; the actual spawn command is resolved at
// runtime (see mcp/manager.js) so a db.json copied between machines never carries
// stale absolute paths. Custom servers store their own command/args.
function seed() {
  return {
    mcpServers: [
      { id: "mcp_sample", name: "sample-tools", kind: "sample", status: "stopped", tools: [], desc: "Bundled demo MCP server — echo, add, server time, agent facts" },
      { id: "mcp_fs", name: "filesystem", kind: "filesystem", status: "stopped", tools: [], desc: "Read files under the project directory (npx server-filesystem)" },
      { id: "mcp_github", name: "github", kind: "github", status: "stopped", tools: [], desc: "GitHub repos, issues, PRs — needs GITHUB_TOKEN" },
      { id: "mcp_hub", name: "agentic-os-hub", kind: "agentic", status: "stopped", tools: [], desc: "Agentic OS itself as MCP tools — what an orchestrator like Hermes connects to" },
      { id: "mcp_obsidian", name: "obsidian", kind: "obsidian", status: "stopped", tools: [], desc: "Read / search / write notes in your Obsidian vault" },
    ],
    integrations: ["openai", "anthropic", "github", "notion", "slack", "postgres", "mila"].map((p) => ({
      id: "int_" + p, provider: p, connected: false, config: {}, testedAt: null, lastResult: null,
    })),
    missions: [],
  };
}

function readOrSeed() {
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, "utf8"));
      const s = seed();
      // forward-compat: backfill any collections added in newer versions
      for (const k of Object.keys(s)) if (loaded[k] === undefined) loaded[k] = s[k];
      if (Array.isArray(loaded.mcpServers)) {
        for (const def of s.mcpServers) if (!loaded.mcpServers.some((x) => x.id === def.id)) loaded.mcpServers.push(def);
      }
      if (Array.isArray(loaded.integrations)) {
        for (const def of s.integrations) if (!loaded.integrations.some((x) => x.id === def.id)) loaded.integrations.push(def);
      }
      return loaded;
    }
  } catch (e) { console.error("[store] load failed:", e.message); }
  const s = seed();
  write(s);
  return s;
}
function write(d) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(d, null, 2), { mode: 0o600 }); hardenRuntimeFile(file, 0o600); }
  catch (e) { console.error("[store] save failed:", e.message); }
}

let data = readOrSeed();
const uid = (p) => p + "_" + Math.random().toString(36).slice(2, 9);

export const db = {
  save() { write(data); },
  mcp: {
    list() { return data.mcpServers; },
    get(id) { return data.mcpServers.find((s) => s.id === id); },
    add(s) { const rec = { id: uid("mcp"), status: "stopped", tools: [], kind: "custom", ...s }; data.mcpServers.push(rec); write(data); return rec; },
    update(id, patch) { const s = db.mcp.get(id); if (s) { Object.assign(s, patch); write(data); } return s; },
    remove(id) { data.mcpServers = data.mcpServers.filter((s) => s.id !== id); write(data); },
  },
  integrations: {
    list() { return data.integrations; },
    get(id) { return data.integrations.find((i) => i.id === id); },
    byProvider(p) { return data.integrations.find((i) => i.provider === p); },
    update(id, patch) { const i = db.integrations.get(id); if (i) { Object.assign(i, patch); write(data); } return i; },
  },
  missions: {
    list() { return data.missions; },
    get(id) { return data.missions.find((m) => m.id === id); },
    create(m) {
      const rec = { id: uid("msn"), title: m.title || "Untitled mission", goal: m.goal || "", status: "pending", orchestrator: m.orchestrator || null, createdAt: Date.now(), events: [] };
      data.missions.unshift(rec); write(data); return rec;
    },
    addEvent(id, ev) {
      const m = db.missions.get(id); if (!m) return null;
      const e = { id: uid("ev"), at: Date.now(), type: ev.type || "log", message: ev.message || "", data: ev.data ?? null };
      m.events.push(e); if (ev.status) m.status = ev.status; write(data); return e;
    },
    update(id, patch) { const m = db.missions.get(id); if (m) { Object.assign(m, patch); write(data); } return m; },
  },
};
