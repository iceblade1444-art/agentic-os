import { Router } from "express";

import { requireRoles } from "../lib/auth.js";
import { readOperationsState, requestOperationsBackup } from "../lib/operations.js";

const r = Router();
const requireAdmin = requireRoles("Creator", "Admin");

r.get("/status", (req, res) => res.json(readOperationsState()));
r.post("/backup", requireAdmin, (req, res) => {
  try { res.status(202).json(requestOperationsBackup()); }
  catch (error) { res.status(503).json({ error: `Could not queue backup: ${error.message}` }); }
});

export default r;
