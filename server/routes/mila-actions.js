import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { milaActions } from "../lib/mila-actions.js";
import { voiceInstruction } from "../lib/voice-instruction.js";

const r = Router();

// A Member's Mila Live call may only read the same ERP data the ERP panel already
// shows it. Kanban, Hermes, Obsidian, Claude Code and MCP tool calls stay operator-only
// — those are the same privileges an Admin has, and voice must not be a side door to them.
const READ_ONLY_ERP_ACTIONS = new Set(["get_erp_business_context", "get_finished_goods_stock"]);
const isOperator = (req) => ["Creator", "Admin"].includes(authenticatedUser(req)?.role);

// The voice agent asks for the prompt instead of keeping its own copy, so a
// phone call and a browser call speak with the same assistant.
r.post("/voice-instruction", (req, res) => {
  try {
    res.json(voiceInstruction(authenticatedUser(req), req.body || {}));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

r.post("/actions", async (req, res) => {
  try {
    const name = String(req.body?.name || "");
    if (!READ_ONLY_ERP_ACTIONS.has(name) && !isOperator(req)) {
      return res.status(403).json({ error: "forbidden", code: "mila_action_restricted", requiredRoles: ["Creator", "Admin"] });
    }
    const actor = authenticatedUser(req)?.name || "Creator";
    res.json(await milaActions.call(name, req.body?.args || {}, { actor }));
  } catch (error) {
    res.status(error.status >= 400 && error.status < 600 ? error.status : 500).json({ error: error.message });
  }
});

export default r;
