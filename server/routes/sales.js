import { Router } from "express";

import { salesBot } from "../lib/sales-bot.js";

// Leads captured by the customer bot. Operator-only: the pipeline is company
// data, and the route is mounted behind requireOperator in index.js.
const r = Router();

r.get("/leads", (req, res) => {
  res.json({ configured: salesBot.configured(), leads: salesBot.leads({ limit: Number(req.query.limit) || 50 }) });
});

r.patch("/leads/:id", (req, res, next) => {
  try {
    res.json({ ok: true, lead: salesBot.setLeadStatus(req.params.id, String(req.body?.status || "")) });
  } catch (error) { next(error); }
});

export default r;
