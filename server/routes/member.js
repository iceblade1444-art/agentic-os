import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { memberWorkspaces } from "../lib/member-workspace.js";

const r = Router();
let readAdapter = null;

const currentUser = (req) => req.user || authenticatedUser(req);

export function configureMemberReadAdapter(adapter) {
  readAdapter = adapter;
}

function sendError(res, error) {
  const status = error.code === "invalid_title" ? 400 : 500;
  res.status(status).json({ error: error.message, code: error.code });
}

r.get("/dashboard", async (req, res) => {
  try {
    const user = currentUser(req);
    res.json({
      ...(readAdapter ? await readAdapter.dashboard(user.id) : memberWorkspaces.dashboard(user.id)),
      account: user,
    });
  } catch (error) { sendError(res, error); }
});

r.get("/tasks", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    res.json(readAdapter ? await readAdapter.listTasks(userId) : memberWorkspaces.listTasks(userId));
  }
  catch (error) { sendError(res, error); }
});

r.post("/tasks", (req, res) => {
  try { res.status(201).json(memberWorkspaces.createTask(currentUser(req).id, req.body)); }
  catch (error) { sendError(res, error); }
});

r.patch("/tasks/:id", (req, res) => {
  try {
    const task = memberWorkspaces.updateTask(currentUser(req).id, req.params.id, req.body);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json(task);
  } catch (error) { sendError(res, error); }
});

r.delete("/tasks/:id", (req, res) => {
  try {
    if (!memberWorkspaces.deleteTask(currentUser(req).id, req.params.id)) return res.status(404).json({ error: "Task not found" });
    res.status(204).end();
  } catch (error) { sendError(res, error); }
});

r.get("/notes", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    res.json(readAdapter ? await readAdapter.listNotes(userId) : memberWorkspaces.listNotes(userId));
  }
  catch (error) { sendError(res, error); }
});

r.post("/notes", (req, res) => {
  try { res.status(201).json(memberWorkspaces.createNote(currentUser(req).id, req.body)); }
  catch (error) { sendError(res, error); }
});

r.patch("/notes/:id", (req, res) => {
  try {
    const note = memberWorkspaces.updateNote(currentUser(req).id, req.params.id, req.body);
    if (!note) return res.status(404).json({ error: "Note not found" });
    res.json(note);
  } catch (error) { sendError(res, error); }
});

r.delete("/notes/:id", (req, res) => {
  try {
    if (!memberWorkspaces.deleteNote(currentUser(req).id, req.params.id)) return res.status(404).json({ error: "Note not found" });
    res.status(204).end();
  } catch (error) { sendError(res, error); }
});

export default r;
