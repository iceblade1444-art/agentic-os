import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { knowledge } from "../lib/knowledge.js";
import * as mcp from "../mcp/manager.js";
import { db } from "../store.js";

const r = Router();

function context(req, fallbackSource = "dashboard") {
  return {
    actor: req.get("X-Agent-Name") || authenticatedUser(req)?.name || "API client",
    source: req.get("X-Agent-Source") || fallbackSource,
  };
}

r.get("/status", async (req, res, next) => {
  try {
    const status = await knowledge.status();
    const server = db.mcp.get("mcp_obsidian");
    res.json({
      ...status,
      mcp: {
        status: mcp.isLive("mcp_obsidian") ? "active" : (server?.status || "stopped"),
        tools: mcp.isLive("mcp_obsidian") ? mcp.getTools("mcp_obsidian").map((tool) => tool.name) : status.tools,
      },
      access: {
        orchestrator: "Hermes",
        policy: "Read, search and approved writes through MCP",
        tools: ["obsidian_status", "obsidian_list_notes", "obsidian_read_note", "obsidian_search_notes", "obsidian_create_note", "obsidian_append_note"],
      },
    });
  } catch (error) { next(error); }
});

r.get("/notes", async (req, res, next) => {
  try { res.json(await knowledge.list({ query: req.query.q || "", ...context(req) })); }
  catch (error) { next(error); }
});

r.get("/notes/read", async (req, res, next) => {
  try { res.json(await knowledge.read(req.query.path, context(req))); }
  catch (error) { next(error); }
});

r.post("/notes", async (req, res, next) => {
  try {
    const { path, content = "" } = req.body || {};
    if (!path) return res.status(400).json({ error: "path is required" });
    res.json(await knowledge.create(path, content, context(req)));
  } catch (error) {
    if (error.code === "EEXIST") return res.status(409).json({ error: "Note already exists" });
    next(error);
  }
});

r.post("/notes/append", async (req, res, next) => {
  try {
    const { path, text } = req.body || {};
    if (!path || !text) return res.status(400).json({ error: "path and text are required" });
    res.json(await knowledge.append(path, text, context(req)));
  } catch (error) { next(error); }
});

r.get("/search", async (req, res, next) => {
  try { res.json(await knowledge.search(req.query.q, { limit: req.query.limit, ...context(req) })); }
  catch (error) { next(error); }
});

r.get("/usage", async (req, res, next) => {
  try { res.json(await knowledge.recentUsage(req.query.limit)); }
  catch (error) { next(error); }
});

export default r;
