// MCP REST API — manage MCP servers, connect/disconnect (spawns real processes),
// list their tools, and call a tool.
import { Router } from "express";
import { db } from "../store.js";
import { config } from "../config.js";
import * as mgr from "../mcp/manager.js";

const r = Router();

const view = (s) => ({
  id: s.id, name: s.name, kind: s.kind, desc: s.desc || "",
  status: mgr.isLive(s.id) ? "active" : (s.status === "error" ? "error" : "stopped"),
  tools: mgr.isLive(s.id) ? mgr.getTools(s.id) : (s.tools || []),
  command: s.kind === "custom" ? s.command : undefined,
  args: s.kind === "custom" ? s.args : undefined,
});

r.get("/servers", (req, res) => res.json(db.mcp.list().map(view)));

r.post("/servers", (req, res) => {
  if (!config.allowCustomMcp) return res.status(403).json({ error: "Adding custom MCP servers is disabled. Set ALLOW_CUSTOM_MCP=true on the server to allow spawning arbitrary commands." });
  const { name, command, args, env } = req.body || {};
  if (!name || !command) return res.status(400).json({ error: "name and command are required" });
  const base = String(command).split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  if (!config.mcpAllowedCommands.includes(base)) {
    return res.status(403).json({ error: `Command '${command}' is not allowed. Allowed base commands: ${config.mcpAllowedCommands.join(", ")}` });
  }
  const argv = Array.isArray(args) ? args : (args ? String(args).split(/\s+/).filter(Boolean) : []);
  const rec = db.mcp.add({ name, command, args: argv, env: env || {} });
  res.json(view(rec));
});

r.delete("/servers/:id", async (req, res) => {
  await mgr.disconnect(req.params.id);
  db.mcp.remove(req.params.id);
  res.json({ ok: true });
});

r.post("/servers/:id/connect", async (req, res) => {
  const s = db.mcp.get(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  try {
    const { tools } = await mgr.connect(s);
    db.mcp.update(s.id, { status: "active", tools });
    res.json({ ok: true, tools });
  } catch (e) {
    db.mcp.update(s.id, { status: "error" });
    res.status(500).json({ error: e.message });
  }
});

r.post("/servers/:id/disconnect", async (req, res) => {
  await mgr.disconnect(req.params.id);
  db.mcp.update(req.params.id, { status: "stopped" });
  res.json({ ok: true });
});

r.post("/servers/:id/call", async (req, res) => {
  const { tool, args } = req.body || {};
  if (!tool) return res.status(400).json({ error: "tool name required" });
  try {
    const result = await mgr.callTool(req.params.id, tool, args || {});
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default r;
