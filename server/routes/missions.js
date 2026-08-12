// Missions API — the queue Hermes (or the built-in orchestrator) pulls from,
// plus a live event feed that shows execution progress in the dashboard.
import { Router } from "express";
import { db } from "../store.js";
import { runMission } from "../lib/orchestrator.js";
import { authenticatedUser } from "../lib/auth.js";
import { journal } from "../lib/journal.js";
import { onboarding } from "../lib/onboarding.js";

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

// Run a mission through Hermes in the AgentOS runtime, streaming events over SSE.
r.post("/:id/run", async (req, res) => {
  const m = db.missions.get(req.params.id);
  if (!m) return res.status(404).json({ error: "not found" });
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  db.missions.update(m.id, { orchestrator: "hermes", status: "running" });
  const user = authenticatedUser(req);
  // The run streams many events; only the terminal one is worth remembering.
  let outcome = null;
  const emit = (ev) => {
    const saved = db.missions.addEvent(m.id, ev) || ev;
    if (ev.status === "completed" || ev.status === "failed") outcome = { status: ev.status, message: ev.message };
    res.write(`data: ${JSON.stringify(saved)}\n\n`);
  };
  try { await runMission(m, emit, user); }
  catch (e) {
    outcome = { status: "failed", message: e.message };
    emit({ type: "error", message: e.message, status: "failed" });
  }
  // A mission is exactly the kind of thing the next session needs to know about,
  // and a failure is worth remembering more than a success.
  await journal.append({
    actor: user?.name,
    timezone: onboarding.get(user).profile?.timezone,
    kind: "mission",
    title: `Миссия ${outcome?.status === "failed" ? "провалена" : "выполнена"}: ${m.title}`,
    detail: outcome?.message || "",
  });
  res.write("data: [DONE]\n\n");
  res.end();
});

export default r;
