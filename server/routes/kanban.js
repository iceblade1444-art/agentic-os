import { Router } from "express";

import { config } from "../config.js";
import { hermesKanbanRequest, kanbanPath } from "../lib/hermes-kanban.js";

const r = Router();
const BOARD = config.hermesKanbanBoard;
const STATUSES = new Set(["triage", "todo", "scheduled", "ready", "blocked", "review", "done", "archived"]);
const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const taskPath = (id, suffix = "") => kanbanPath(`/tasks/${encodeURIComponent(id)}${suffix}`, BOARD);
const bounded = (value, max) => String(value || "").trim().slice(0, max);

function handle(handler) {
  return async (req, res) => {
    try { res.json(await handler(req)); }
    catch (error) { res.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({ error: error.message }); }
  };
}

r.get("/board", handle(() => hermesKanbanRequest(kanbanPath("/board", BOARD))));
r.get("/profiles", handle(() => hermesKanbanRequest(kanbanPath("/profiles", BOARD))));
r.get("/orchestration", handle(() => hermesKanbanRequest(kanbanPath("/orchestration", BOARD))));

r.put("/orchestration", handle((req) => {
  const body = {};
  if (typeof req.body?.auto_decompose === "boolean") body.auto_decompose = req.body.auto_decompose;
  if (typeof req.body?.auto_promote_children === "boolean") body.auto_promote_children = req.body.auto_promote_children;
  for (const key of ["orchestrator_profile", "default_assignee"]) {
    if (req.body?.[key] === undefined) continue;
    const value = bounded(req.body[key], 64);
    if (value && !PROFILE_NAME.test(value)) throw Object.assign(new Error(`Invalid ${key}`), { status: 400 });
    body[key] = value;
  }
  return hermesKanbanRequest(kanbanPath("/orchestration", BOARD), { method: "PUT", body });
}));

r.post("/tasks", handle(async (req) => {
  const title = bounded(req.body?.title, 240);
  if (!title) throw Object.assign(new Error("Task title is required"), { status: 400 });
  const initialStatus = STATUSES.has(req.body?.initialStatus) ? req.body.initialStatus : "triage";
  if (!["triage", "todo", "ready"].includes(initialStatus)) {
    throw Object.assign(new Error("New tasks can start only in triage, todo or ready"), { status: 400 });
  }
  let assignee = bounded(req.body?.assignee, 64) || "default";
  if (!PROFILE_NAME.test(assignee)) throw Object.assign(new Error("Invalid assignee"), { status: 400 });
  if (initialStatus === "triage") assignee = "default";
  const created = await hermesKanbanRequest(kanbanPath("/tasks", BOARD), {
    method: "POST",
    body: {
      title,
      body: bounded(req.body?.body, 20000) || null,
      assignee,
      priority: Math.max(0, Math.min(3, Number(req.body?.priority) || 0)),
      triage: initialStatus === "triage",
      workspace_kind: "scratch",
      max_runtime_seconds: 3600,
    },
  });
  const id = created.task?.id;
  if (id && initialStatus === "ready") {
    await hermesKanbanRequest(taskPath(id), { method: "PATCH", body: { status: "ready" } });
    return hermesKanbanRequest(taskPath(id));
  }
  return created;
}));

r.get("/tasks/:id", handle((req) => hermesKanbanRequest(taskPath(req.params.id))));

r.patch("/tasks/:id", handle((req) => {
  const body = {};
  if (req.body?.status !== undefined) {
    if (!STATUSES.has(req.body.status)) throw Object.assign(new Error("Invalid task status"), { status: 400 });
    body.status = req.body.status;
  }
  if (req.body?.assignee !== undefined) {
    const assignee = bounded(req.body.assignee, 64);
    if (assignee && !PROFILE_NAME.test(assignee)) throw Object.assign(new Error("Invalid assignee"), { status: 400 });
    body.assignee = assignee;
  }
  if (req.body?.priority !== undefined) body.priority = Math.max(0, Math.min(3, Number(req.body.priority) || 0));
  if (req.body?.title !== undefined) body.title = bounded(req.body.title, 240);
  if (req.body?.body !== undefined) body.body = bounded(req.body.body, 20000);
  if (req.body?.block_reason !== undefined) body.block_reason = bounded(req.body.block_reason, 2000);
  if (req.body?.result !== undefined) body.result = bounded(req.body.result, 10000);
  if (req.body?.summary !== undefined) body.summary = bounded(req.body.summary, 10000);
  return hermesKanbanRequest(taskPath(req.params.id), { method: "PATCH", body });
}));

r.post("/tasks/:id/comments", handle((req) => {
  const body = bounded(req.body?.body, 5000);
  if (!body) throw Object.assign(new Error("Comment is required"), { status: 400 });
  return hermesKanbanRequest(taskPath(req.params.id, "/comments"), {
    method: "POST", body: { body, author: bounded(req.body?.author, 80) || "Agentic OS" },
  });
}));

r.post("/tasks/:id/decompose", handle((req) => hermesKanbanRequest(taskPath(req.params.id, "/decompose"), { method: "POST", body: {} })));
r.post("/dispatch", handle(() => hermesKanbanRequest(kanbanPath("/dispatch?max=4", BOARD), { method: "POST", body: {} })));

export default r;
