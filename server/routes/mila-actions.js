import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { milaActions, PERSONAL_ACTIONS } from "../lib/mila-actions.js";
import { voiceInstruction } from "../lib/voice-instruction.js";

const r = Router();

// A Member's Mila Live call may only read the same ERP data the ERP panel already
// shows it. Kanban, Hermes, Obsidian, Claude Code and MCP tool calls stay operator-only
// — those are the same privileges an Admin has, and voice must not be a side door to them.
//
// Personal actions are the exception, and not a widening: they run against the
// caller's own tasks, notes, reminders and calendar, so a Member using them reaches
// exactly the data that is already theirs on the Personal page.
const READ_ONLY_ERP_ACTIONS = new Set(["get_erp_business_context", "get_finished_goods_stock"]);
const isOperator = (req) => ["Creator", "Admin"].includes(authenticatedUser(req)?.role);
const allowedForEveryone = (name) => READ_ONLY_ERP_ACTIONS.has(name) || PERSONAL_ACTIONS.has(name);

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
    if (!allowedForEveryone(name) && !isOperator(req)) {
      return res.status(403).json({ error: "forbidden", code: "mila_action_restricted", requiredRoles: ["Creator", "Admin"] });
    }
    const user = authenticatedUser(req);
    res.json(await milaActions.call(name, req.body?.args || {}, { actor: user?.name || "Creator", user }));
  } catch (error) {
    res.status(error.status >= 400 && error.status < 600 ? error.status : 500).json({ error: error.message });
  }
});

export default r;
