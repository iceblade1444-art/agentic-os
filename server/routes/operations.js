import { Router } from "express";

import { authenticatedUser, requireRoles } from "../lib/auth.js";
import { readOperationsState, requestOperationsBackup, requestOperationsRestoreDrill } from "../lib/operations.js";
import { readFourCReadiness } from "../lib/readiness.js";

const r = Router();
const requireAdmin = requireRoles("Creator", "Admin", "CEO");

r.get("/status", async (req, res) => {
  const state = readOperationsState();
  try { res.json({ ...state, readiness: await readFourCReadiness(authenticatedUser(req)) }); }
  catch (error) { res.json({ ...state, readiness: { status: "blocked", score: 0, sections: [], recommendations: [], error: error.message } }); }
});
r.post("/backup", requireAdmin, (req, res) => {
  try { res.status(202).json(requestOperationsBackup()); }
  catch (error) { res.status(503).json({ error: `Could not queue backup: ${error.message}` }); }
});
r.post("/restore-drill", requireAdmin, (req, res) => {
  try { res.status(202).json(requestOperationsRestoreDrill()); }
  catch (error) { res.status(503).json({ error: `Could not queue restore drill: ${error.message}` }); }
});

export default r;
