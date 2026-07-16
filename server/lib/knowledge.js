import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";

const MAX_NOTE_BYTES = 1024 * 1024;
const MAX_WRITE_CHARS = 500000;
const MAX_NOTES = 1000;
const MAX_USAGE = 500;

export const OBSIDIAN_TOOLS = [
  "list_notes", "read_note", "search_notes", "create_note", "append_note",
];

const slash = (value) => value.split(path.sep).join("/");
const cleanText = (value, max = 200) => String(value || "").trim().slice(0, max);

async function readPrefix(file, limit = MAX_NOTE_BYTES) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

function displayTitle(relativePath, body) {
  const heading = String(body || "").match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(relativePath, ".md");
}

function excerpt(body) {
  return String(body || "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/!?(\[([^\]]+)\]\([^\)]+\)|\[\[([^\]]+)\]\])/g, "$2$3")
    .replace(/^[#>*`\-\s]+/gm, "")
    .replace(/\s+/g, " ").trim().slice(0, 220);
}

function tags(body) {
  return [...new Set((String(body || "").match(/(^|\s)#[\p{L}\p{N}_/-]+/gu) || [])
    .map((tag) => tag.trim().slice(1)).filter(Boolean))].slice(0, 12);
}

function links(body) {
  return [...String(body || "").matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)]
    .map((match) => match[1].trim()).filter(Boolean).slice(0, 30);
}

export class KnowledgeLibrary {
  constructor({ vaultDir, usageFile } = {}) {
    this.vaultDir = path.resolve(vaultDir || config.obsidianVault);
    this.usageFile = path.resolve(usageFile || path.join(config.dataDir, "knowledge-usage.json"));
    this.rootReal = null;
    this.usage = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.vaultDir, { recursive: true });
    this.rootReal = await fs.realpath(this.vaultDir);
    return this;
  }

  normalize(relativePath) {
    let value = String(relativePath || "").trim().replace(/\\/g, "/");
    if (!value || value.includes("\0") || value.startsWith(".") || value.split("/").some((part) => part === ".." || part.startsWith("."))) {
      throw new Error("Invalid vault note path");
    }
    if (!value.toLowerCase().endsWith(".md")) value += ".md";
    if (value.length > 300) throw new Error("Vault note path is too long");
    return value;
  }

  inside(realPath) {
    return realPath === this.rootReal || realPath.startsWith(this.rootReal + path.sep);
  }

  async resolveRead(relativePath) {
    await this.init();
    const normalized = this.normalize(relativePath);
    const candidate = path.resolve(this.rootReal, ...normalized.split("/"));
    if (!this.inside(candidate)) throw new Error("Path escapes the vault");
    const real = await fs.realpath(candidate);
    if (!this.inside(real)) throw new Error("Path escapes the vault");
    return { normalized, file: real };
  }

  async resolveWrite(relativePath) {
    await this.init();
    const normalized = this.normalize(relativePath);
    const candidate = path.resolve(this.rootReal, ...normalized.split("/"));
    if (!this.inside(candidate)) throw new Error("Path escapes the vault");
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    const parentReal = await fs.realpath(path.dirname(candidate));
    if (!this.inside(parentReal)) throw new Error("Path escapes the vault");
    return { normalized, file: path.join(parentReal, path.basename(candidate)) };
  }

  async walk(dir = null, out = []) {
    await this.init();
    const current = dir || this.rootReal;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await this.walk(file, out);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(file);
      if (out.length >= MAX_NOTES) break;
    }
    return out;
  }

  async noteMeta(file) {
    const stat = await fs.stat(file);
    const body = await readPrefix(file);
    const relativePath = slash(path.relative(this.rootReal, file));
    return {
      path: relativePath,
      title: displayTitle(relativePath, body),
      folder: slash(path.dirname(relativePath)) === "." ? "Vault root" : slash(path.dirname(relativePath)),
      size: stat.size,
      updatedAt: stat.mtimeMs,
      excerpt: excerpt(body),
      tags: tags(body),
      links: links(body),
    };
  }

  async list({ query = "", actor = "", source = "dashboard" } = {}) {
    const q = cleanText(query, 200).toLowerCase();
    const notes = await Promise.all((await this.walk()).map((file) => this.noteMeta(file)));
    const filtered = q ? notes.filter((note) => `${note.path} ${note.title} ${note.excerpt} ${note.tags.join(" ")}`.toLowerCase().includes(q)) : notes;
    filtered.sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
    await this.record({ actor, action: q ? "search" : "list", query: q, source, count: filtered.length });
    return filtered;
  }

  async read(relativePath, { actor = "", source = "dashboard" } = {}) {
    const { normalized, file } = await this.resolveRead(relativePath);
    const stat = await fs.stat(file);
    if (stat.size > MAX_NOTE_BYTES) throw new Error("Note is larger than 1 MB");
    const content = await fs.readFile(file, "utf8");
    await this.record({ actor, action: "read", path: normalized, source });
    return { ...(await this.noteMeta(file)), content };
  }

  async search(query, { limit = 20, actor = "", source = "agent" } = {}) {
    const q = cleanText(query, 300);
    if (!q) throw new Error("Search query is required");
    const matches = [];
    for (const file of await this.walk()) {
      const body = await readPrefix(file);
      const index = body.toLowerCase().indexOf(q.toLowerCase());
      if (index !== -1) {
        matches.push({
          path: slash(path.relative(this.rootReal, file)),
          title: displayTitle(file, body),
          snippet: body.slice(Math.max(0, index - 90), index + q.length + 150).replace(/\s+/g, " ").trim(),
        });
      }
      if (matches.length >= Math.min(100, Math.max(1, Number(limit) || 20))) break;
    }
    await this.record({ actor, action: "search", query: q, source, count: matches.length });
    return { query: q, matches };
  }

  async create(relativePath, content, { actor = "", source = "dashboard" } = {}) {
    const value = String(content || "");
    if (value.length > MAX_WRITE_CHARS || Buffer.byteLength(value) > MAX_NOTE_BYTES) throw new Error("Note content is too large");
    const { normalized, file } = await this.resolveWrite(relativePath);
    await fs.writeFile(file, value, { flag: "wx" });
    await this.record({ actor, action: "create", path: normalized, source });
    return { ...(await this.noteMeta(file)), content: value };
  }

  async append(relativePath, text, { actor = "", source = "agent" } = {}) {
    const value = String(text || "");
    if (!value.trim()) throw new Error("Text is required");
    if (value.length > MAX_WRITE_CHARS) throw new Error("Note content is too large");
    const { normalized, file } = await this.resolveWrite(relativePath);
    const existingSize = await fs.stat(file).then((stat) => stat.size).catch((error) => error.code === "ENOENT" ? 0 : Promise.reject(error));
    if (existingSize + Buffer.byteLength(value) > MAX_NOTE_BYTES) throw new Error("Note is larger than 1 MB");
    await fs.appendFile(file, `${value.startsWith("\n") ? "" : "\n"}${value}`);
    await this.record({ actor, action: "append", path: normalized, source });
    return { ...(await this.noteMeta(file)), content: await fs.readFile(file, "utf8") };
  }

  async status() {
    await this.init();
    const files = await this.walk();
    const stats = await Promise.all(files.map((file) => fs.stat(file)));
    const folders = new Set(files.map((file) => slash(path.dirname(path.relative(this.rootReal, file)))).filter((folder) => folder !== "."));
    let writable = true;
    try { await fs.access(this.rootReal, fs.constants.W_OK); } catch { writable = false; }
    return {
      name: "Agentic OS Obsidian Vault",
      path: process.env.OBSIDIAN_VAULT || config.obsidianVault,
      ready: true,
      writable,
      notes: files.length,
      folders: folders.size,
      bytes: stats.reduce((sum, stat) => sum + stat.size, 0),
      updatedAt: stats.length ? Math.max(...stats.map((stat) => stat.mtimeMs)) : null,
      tools: OBSIDIAN_TOOLS,
    };
  }

  async loadUsage() {
    if (this.usage) return this.usage;
    try {
      const parsed = JSON.parse(await fs.readFile(this.usageFile, "utf8"));
      this.usage = Array.isArray(parsed) ? parsed : [];
    } catch { this.usage = []; }
    return this.usage;
  }

  async record({ actor, action, path: notePath = "", query = "", source = "agent", count = null, outcome = "success" }) {
    const cleanActor = cleanText(actor || (source === "dashboard" ? "Creator" : "Agent"), 120);
    const entry = {
      id: `kuse_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(), actor: cleanActor, action: cleanText(action, 40),
      path: cleanText(notePath, 300), query: cleanText(query, 300),
      source: cleanText(source, 60), outcome: cleanText(outcome, 30), count,
    };
    const usage = await this.loadUsage();
    usage.unshift(entry);
    this.usage = usage.slice(0, MAX_USAGE);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.usageFile), { recursive: true });
      await fs.writeFile(this.usageFile, JSON.stringify(this.usage, null, 2));
    }).catch(() => {});
    await this.writeQueue;
    return entry;
  }

  async recentUsage(limit = 50) {
    return (await this.loadUsage()).slice(0, Math.min(200, Math.max(1, Number(limit) || 50)));
  }

  async recordMcp(tool, args = {}, { actor = "Agent", source = "obsidian-mcp", outcome = "success" } = {}) {
    const action = ({ list_notes: "list", read_note: "read", search_notes: "search", create_note: "create", append_note: "append" })[tool] || tool;
    return this.record({ actor, action, path: args.path || "", query: args.query || "", source, outcome });
  }
}

export const knowledge = new KnowledgeLibrary();
