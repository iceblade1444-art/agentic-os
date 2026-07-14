// "obsidian" MCP server — exposes an Obsidian vault (a folder of Markdown notes)
// as MCP tools so agents/orchestrators (Hermes, the built-in orchestrator) can
// read, search, and write your notes as part of a mission.
//
// Vault path from OBSIDIAN_VAULT (default ./vault). All paths are confined to the
// vault (no traversal outside). stdout is the MCP channel — logs go to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

const VAULT = path.resolve(process.env.OBSIDIAN_VAULT || "./vault");
await fs.mkdir(VAULT, { recursive: true }).catch(() => {});

function resolveInVault(p) {
  const withExt = /\.[a-z0-9]+$/i.test(p) ? p : p + ".md";
  const r = path.resolve(VAULT, withExt);
  if (r !== VAULT && !r.startsWith(VAULT + path.sep)) throw new Error("path escapes the vault");
  return r;
}
async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(fp));
    else if (e.name.endsWith(".md")) out.push(path.relative(VAULT, fp).split(path.sep).join("/"));
  }
  return out;
}
const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });

const server = new McpServer({ name: "obsidian", version: "1.0.0" });

server.registerTool("list_notes",
  { description: "List all note paths (relative to the vault root).", inputSchema: {} },
  async () => text({ vault: VAULT, notes: await walk(VAULT) }));

server.registerTool("read_note",
  { description: "Read a note's Markdown content.", inputSchema: { path: z.string().describe("note path relative to the vault, e.g. 'Projects/Ideas.md'") } },
  async ({ path: p }) => text(await fs.readFile(resolveInVault(p), "utf8")));

server.registerTool("search_notes",
  { description: "Full-text search across all notes; returns matching notes with a snippet.", inputSchema: { query: z.string(), limit: z.number().optional() } },
  async ({ query, limit = 20 }) => {
    const q = query.toLowerCase();
    const hits = [];
    for (const rel of await walk(VAULT)) {
      const body = await fs.readFile(path.join(VAULT, rel), "utf8");
      const i = body.toLowerCase().indexOf(q);
      if (i !== -1) hits.push({ path: rel, snippet: body.slice(Math.max(0, i - 60), i + 120).replace(/\n/g, " ") });
      if (hits.length >= limit) break;
    }
    return text({ query, matches: hits });
  });

server.registerTool("create_note",
  { description: "Create a new note (fails if it already exists).", inputSchema: { path: z.string(), content: z.string() } },
  async ({ path: p, content }) => {
    const fp = resolveInVault(p);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, content, { flag: "wx" });
    return text("created " + path.relative(VAULT, fp).split(path.sep).join("/"));
  });

server.registerTool("append_note",
  { description: "Append text to a note (creates it if missing).", inputSchema: { path: z.string(), text: z.string() } },
  async ({ path: p, text: t }) => {
    const fp = resolveInVault(p);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.appendFile(fp, (t.startsWith("\n") ? "" : "\n") + t);
    return text("appended to " + path.relative(VAULT, fp).split(path.sep).join("/"));
  });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[obsidian] MCP server ready · vault: " + VAULT);
