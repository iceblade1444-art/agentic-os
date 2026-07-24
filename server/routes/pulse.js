// Operational pulse endpoints for the dashboard: one composed GET with host
// metrics + approvals + runtime events + sparkline history, an SSE activity
// stream, and the Creator/Admin-gated approval decision proxy.
import { Router } from "express";

import { config } from "../config.js";
import { requireRoles } from "../lib/auth.js";
import { hermesCronRequest, hermesKanbanRequest, kanbanPath } from "../lib/hermes-kanban.js";
import { knowledge } from "../lib/knowledge.js";
import { decideApproval, hostMetrics, missionStats, pendingApprovals, readHistory, recordSample, runtimeEvents } from "../lib/pulse.js";
import { db } from "../store.js";

const r = Router();
const OPEN_STATUSES = new Set(["triage", "todo", "scheduled", "ready", "running", "blocked", "review"]);

const settle = (promise, fallback, timeoutMs = 3500) => Promise.race([
  Promise.resolve(promise).catch(() => fallback),
  new Promise((resolve) => setTimeout(resolve, timeoutMs, fallback).unref?.()),
]);

function boardCounts(board) {
  if (!board || !Array.isArray(board.columns)) return null;
  const tasks = board.columns.flatMap((column) => (column.tasks || []).map((task) => ({ ...task, status: task.status || column.name })));
  return {
    open: tasks.filter((task) => OPEN_STATUSES.has(task.status)).length,
    running: tasks.filter((task) => task.status === "running").length,
    blocked: tasks.filter((task) => task.status === "blocked" && task.block_kind !== "needs_input").length,
    waiting: tasks.filter((task) => task.status === "blocked" && task.block_kind === "needs_input").length,
  };
}

function routinesCount(jobs) {
  const list = Array.isArray(jobs) ? jobs : Array.isArray(jobs?.jobs) ? jobs.jobs : null;
  if (!list) return null;
  return list.filter((job) => job && job.enabled !== false && !job.paused && job.status !== "paused").length;
}

r.get("/", async (req, res) => {
  const host = hostMetrics();
  // Every probe is capped well below the dashboard's client-side bound so a
  // down Hermes bridge degrades this response to ~2.5 s, never a timeout.
  const [approvals, events, board, cronJobs] = await Promise.all([
    settle(pendingApprovals(), null, 3000),
    settle(runtimeEvents(30), [], 3000),
    settle(hermesKanbanRequest(kanbanPath("/board", config.hermesKanbanBoard)), null, 2500),
    settle(hermesCronRequest("/api/cron/jobs?profile=all"), null, 2500),
  ]);
  const counts = boardCounts(board);
  const routines = routinesCount(cronJobs);
  const missions = missionStats(db.missions.list());
  let history = readHistory();
  if (counts || approvals) {
    history = recordSample({
      open: counts?.open, running: counts?.running, blocked: counts?.blocked, waiting: counts?.waiting,
      approvals: approvals ? approvals.length : undefined,
      routines: routines ?? undefined,
      disk: host.disk?.usedPct, memory: host.memory?.usedPct,
    });
  }
  res.json({
    host,
    approvals: approvals || [],
    approvalsAvailable: approvals !== null,
    events,
    history,
    missions,
  });
});

r.post("/approvals/:id/:decision", requireRoles("Creator", "Admin"), async (req, res) => {
  try { res.json(await decideApproval(req.params.id, req.params.decision)); }
  catch (error) {
    const status = error.status >= 400 && error.status < 600 ? error.status : 502;
    res.status(status).json({ error: error.message });
  }
});

// SSE activity stream: merges runtime events and knowledge usage, pushing only
// entries newer than the client's watermark every tick. One dashboard viewer
// costs two bounded local probes per tick.
r.get("/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  let watermark = Number(req.query.since) || Date.now();
  let closed = false;
  const tick = async () => {
    if (closed) return;
    const [events, usage] = await Promise.all([
      settle(runtimeEvents(20), []),
      settle(Promise.resolve().then(() => knowledge.recentUsage(20)), []),
    ]);
    const merged = [
      ...events.map((event) => ({ at: event.at, actor: event.actor, message: event.message || event.type, source: "runtime" })),
      ...(Array.isArray(usage) ? usage : []).map((entry) => ({
        at: Number(entry.at) || null,
        actor: String(entry.actor || "Agent").slice(0, 80),
        message: `${String(entry.action || "used knowledge").slice(0, 40)}${entry.path ? ` · ${String(entry.path).slice(0, 120)}` : ""}`,
        source: "knowledge",
      })),
    ].filter((entry) => entry.at && entry.at > watermark).sort((a, b) => a.at - b.at);
    for (const entry of merged.slice(-20)) {
      watermark = Math.max(watermark, entry.at);
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
  };
  const interval = setInterval(() => { tick().catch(() => {}); }, 6000);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25000);
  req.on("close", () => { closed = true; clearInterval(interval); clearInterval(keepAlive); });
});

export default r;
