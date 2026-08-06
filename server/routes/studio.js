import { Router } from "express";
import { config } from "../config.js";

import { authenticatedUser } from "../lib/auth.js";
import { governance } from "../lib/governance.js";
import { hermesKanbanRequest, kanbanPath } from "../lib/hermes-kanban.js";
import { studio } from "../lib/studio.js";

const r = Router();
const BOARD = config.hermesKanbanBoard;
const JOB_STATUS_BY_TASK = {
  triage: "queued", todo: "queued", scheduled: "queued", ready: "queued",
  running: "running", review: "review", blocked: "failed", done: "complete", archived: "complete",
};
const buckets = {
  collections: studio.collections,
  models: studio.models,
  campaigns: studio.campaigns,
  signals: studio.signals,
  generations: studio.generations,
};

const audit = (req, action, target, detail = "") =>
  governance.recordAudit(action, authenticatedUser(req)?.name, target, detail);

function handle(handler) {
  return async (req, res) => {
    try { await handler(req, res); }
    catch (error) { res.status(error.status || 500).json({ error: error.message, code: error.code }); }
  };
}

r.get("/", (req, res) => res.json(studio.snapshot()));

for (const [bucket, service] of Object.entries(buckets)) {
  r.post(`/${bucket}`, handle(async (req, res) => {
    const item = service.create({ ...req.body, requestedBy: authenticatedUser(req)?.name });
    audit(req, `studio.${bucket}.create`, item.id, item.name || item.title || item.brief);
    res.status(201).json(item);
  }));
  r.patch(`/${bucket}/:id`, handle(async (req, res) => {
    const item = service.update(req.params.id, req.body);
    if (!item) return res.status(404).json({ error: "Not found" });
    audit(req, `studio.${bucket}.update`, item.id);
    res.json(item);
  }));
  r.delete(`/${bucket}/:id`, handle(async (req, res) => {
    if (!service.remove(req.params.id)) return res.status(404).json({ error: "Not found" });
    audit(req, `studio.${bucket}.delete`, req.params.id);
    res.status(204).end();
  }));
}

r.post("/generations/:id/queue", handle(async (req, res) => {
  const snapshot = studio.snapshot();
  const job = snapshot.generationJobs.find((item) => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Generation job not found" });
  const kind = job.type === "video" ? "video" : "image";
  const task = await hermesKanbanRequest(kanbanPath("/tasks", BOARD), {
    method: "POST",
    body: {
      title: `Higgsfield ${kind}: ${job.brief.slice(0, 120)}`,
      body: [
        "Use the official Higgsfield MCP connector.",
        `Create a ${kind} in ${job.aspectRatio} format.`,
        job.modelId ? `Agentic OS model ID: ${job.modelId}.` : "",
        job.campaignId ? `Campaign ID: ${job.campaignId}.` : "",
        `Creative brief: ${job.brief}`,
        "Return the generation URL and a concise production note. Do not claim completion until the Higgsfield result is available.",
      ].filter(Boolean).join("\n"),
      assignee: "reach",
      priority: Number(req.body?.priority) || 1,
      triage: false,
      workspace_kind: "scratch",
      max_runtime_seconds: 3600,
    },
  });
  const taskId = task.task?.id || task.id || "";
  const updated = studio.generations.update(job.id, { status: "queued", kanbanTaskId: taskId });
  audit(req, "studio.higgsfield.queue", job.id, `kanban ${taskId || "created"}`);
  res.json({ job: updated, task });
}));

r.post("/generations/:id/sync", handle(async (req, res) => {
  const job = studio.snapshot().generationJobs.find((item) => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Generation job not found" });
  if (!job.kanbanTaskId) return res.status(409).json({ error: "Generation job is not linked to Kanban" });
  const detail = await hermesKanbanRequest(kanbanPath(`/tasks/${encodeURIComponent(job.kanbanTaskId)}`, BOARD));
  const task = detail.task || detail;
  const resultText = [
    task.result, task.latest_summary,
    ...(detail.child_results || []).map((item) => item.result || item.latest_summary),
    ...(detail.comments || []).map((item) => item.body || item.message),
  ].filter(Boolean).join("\n");
  const outputUrl = resultText.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.;]+$/, "") || job.outputUrl;
  const status = JOB_STATUS_BY_TASK[task.status] || job.status;
  const updated = studio.generations.update(job.id, {
    status,
    outputUrl,
    error: task.status === "blocked" ? task.block_reason || task.latest_summary || "Hermes task blocked" : "",
  });
  if (updated.status === "complete" && updated.outputUrl) studio.generations.attachOutput(updated.id);
  audit(req, "studio.higgsfield.sync", job.id, `kanban ${job.kanbanTaskId}; ${status}`);
  res.json({ job: updated, taskStatus: task.status, hasOutput: Boolean(outputUrl) });
}));

export default r;
