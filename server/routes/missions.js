// Missions API — the queue Hermes (or the built-in orchestrator) pulls from,
// plus a live event feed that shows execution progress in the dashboard.
import { Router } from "express";
import { db } from "../store.js";
import { runMission } from "../lib/orchestrator.js";

const r = Router();
const summary = (m) => ({ id: m.id, title: m.title, goal: m.goal, status: m.status, orchestrator: m.orchestrator, createdAt: m.createdAt, events: m.events.length });

r.get("/", (req, res) => res.json(db.missions.list().map(summary)));

r.post("/", (req, res) => {
  const { title, goal, orchestrator } = req.body || {};
  if (!title && !goal) return res.status(400).json({ error: "title or goal required" });
  res.json(db.missions.create({ title: title || goal, goal, orchestrator }));
});

r.get("/:id", (req, res) => {
  const m = db.missions.get(req.params.id);
  if (!m) return res.status(404).json({ error: "not found" });
  res.json(m);
});

r.post("/:id/events", (req, res) => {
  const e = db.missions.addEvent(req.params.id, req.body || {});
  if (!e) return res.status(404).json({ error: "not found" });
  res.json(e);
});

r.patch("/:id", (req, res) => {
  const m = db.missions.update(req.params.id, req.body || {});
  if (!m) return res.status(404).json({ error: "not found" });
  res.json(summary(m));
});

// Run a mission with the built-in orchestrator, streaming events over SSE.
r.post("/:id/run", async (req, res) => {
  const m = db.missions.get(req.params.id);
  if (!m) return res.status(404).json({ error: "not found" });
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  db.missions.update(m.id, { orchestrator: "built-in", status: "running" });
  const emit = (ev) => { const saved = db.missions.addEvent(m.id, ev) || ev; res.write(`data: ${JSON.stringify(saved)}\n\n`); };
  try { await runMission(m, emit); }
  catch (e) { emit({ type: "error", message: e.message, status: "failed" }); }
  res.write("data: [DONE]\n\n");
  res.end();
});

export default r;
