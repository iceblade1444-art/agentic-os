import { Router } from "express";

import { authenticatedUser, requireRoles } from "../lib/auth.js";
import { productionIntelligence } from "../lib/production-intelligence.js";

const r = Router();
const requireExecutive = requireRoles("Creator", "Admin", "CEO");

r.get("/", async (req, res, next) => {
  try {
    const result = await productionIntelligence.dashboard(authenticatedUser(req));
    const status = result.ok !== false ? 200
      : result.code === "production_postgres_not_configured" ? 503 : 403;
    res.status(status).json(result.ok === false ? { ...result, error: result.message } : result);
  } catch (error) { next(error); }
});

r.post("/sync", requireExecutive, async (_req, res, next) => {
  try { res.json({ ok: true, ...(await productionIntelligence.sync()) }); }
  catch (error) {
    if (error.status) return res.status(error.status).json({ ok: false, code: error.code, error: error.message });
    next(error);
  }
});

export default r;
