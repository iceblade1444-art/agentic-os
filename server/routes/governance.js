import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { activeGuardrails, governance } from "../lib/governance.js";
import { readFourCReadiness } from "../lib/readiness.js";

const r = Router();
const actor = (req) => authenticatedUser(req)?.name || "Agentic OS";

r.get("/guardrails", (req, res) => {
  const rules = activeGuardrails();
  res.json({
    active: rules.filter((rule) => rule.active).length,
    total: rules.length,
    rules,
  });
});

r.get("/secrets", (req, res) => res.json(governance.listSecrets()));
r.post("/secrets", (req, res) => {
  try { res.status(201).json(governance.setSecret(req.body || {}, actor(req))); }
  catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code }); }
});
r.delete("/secrets/:id", (req, res) => {
  const removed = governance.removeSecret(req.params.id, actor(req));
  if (!removed) return res.status(404).json({ error: "Secret not found" });
  res.json({ ok: true, secret: removed });
});

r.get("/evaluations", (req, res) => res.json(governance.listEvaluations()));
r.post("/evaluations/run", async (req, res, next) => {
  try {
    const readiness = await readFourCReadiness(authenticatedUser(req));
    res.status(201).json(governance.recordEvaluation(readiness, actor(req)));
  } catch (error) { next(error); }
});

r.get("/audit", (req, res) => res.json(governance.audit(req.query.limit)));

export default r;
