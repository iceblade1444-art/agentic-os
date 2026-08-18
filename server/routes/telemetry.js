import { Router } from "express";

import { authenticatedUser, requireRoles } from "../lib/auth.js";
import { recordVoiceMetric, voiceMetricSummary } from "../lib/voice-metrics.js";

const r = Router();

r.post("/voice", (req, res, next) => {
  try { res.status(202).json(recordVoiceMetric(req.user || authenticatedUser(req), req.body)); }
  catch (error) { next(error); }
});

r.get("/voice", requireRoles("Creator", "Admin", "CEO"), (_req, res) => {
  res.json(voiceMetricSummary());
});

export default r;
