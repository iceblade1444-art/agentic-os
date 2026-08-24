// GET /api/needs-you — everything blocked on the person asking, worst first.
//
// Authenticated but not operator-gated: everyone has a queue, it is just that
// an operator's also contains the fleet's. Which sources a caller sees is
// decided inside needs-you.js by their role, never here, so a new caller
// cannot accidentally be handed somebody else's.

import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { config } from "../config.js";
import { hermesKanbanRequest, kanbanPath } from "../lib/hermes-kanban.js";
import { memberWorkspaces } from "../lib/member-workspace.js";
import { milaActions } from "../lib/mila-actions.js";
import { needsYou } from "../lib/needs-you.js";
import { pendingApprovals } from "../lib/pulse.js";

const r = Router();

// The same bound the dashboard's pulse call uses. A down Hermes bridge must
// degrade this to "no fleet items", never to a spinner that never resolves —
// the queue is the first thing on every screen and it cannot be the slowest.
const BUDGET_MS = 2500;
const settle = (promise, fallback) => Promise.race([
  Promise.resolve(promise).catch(() => fallback),
  new Promise((resolve) => setTimeout(resolve, BUDGET_MS, fallback).unref?.()),
]);

r.get("/", async (req, res) => {
  const user = req.user || authenticatedUser(req);
  if (!user) return res.status(401).json({ error: "Authentication required" });
  try {
    const result = await needsYou(user, {
      workspaces: memberWorkspaces,
      board: () => settle(hermesKanbanRequest(kanbanPath("/board", config.hermesKanbanBoard)), null),
      approvals: () => settle(pendingApprovals(), null),
      // Synchronous and in-process: what MILA is holding for this person.
      staged: (id) => milaActions.listPending(id),
    });
    res.json(result);
  } catch (error) {
    console.error(`[needs-you] ${error.message}`);
    res.status(500).json({ error: "Could not build the queue" });
  }
});

export default r;
