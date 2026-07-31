import { Router } from "express";

import { authenticatedUser, creatorUser } from "../lib/auth.js";
import { memberWorkspaces } from "../lib/member-workspace.js";
import { users } from "../lib/users.js";

const r = Router();
let readAdapter = null;
let writeAdapter = null;

const currentUser = (req) => req.user || authenticatedUser(req);

export function configureMemberReadAdapter(adapter) {
  readAdapter = adapter;
}

export function configureMemberWriteAdapter(adapter) {
  writeAdapter = adapter;
}

function sendError(res, error) {
  const status = error.status || (error.code === "invalid_title" ? 400 : 500);
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

r.post("/tasks", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    res.status(201).json(writeAdapter
      ? await writeAdapter.createTask(userId, req.body)
      : memberWorkspaces.createTask(userId, req.body));
  }
  catch (error) { sendError(res, error); }
});

r.patch("/tasks/:id", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    const task = writeAdapter
      ? await writeAdapter.updateTask(userId, req.params.id, req.body)
      : memberWorkspaces.updateTask(userId, req.params.id, req.body);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json(task);
  } catch (error) { sendError(res, error); }
});

r.delete("/tasks/:id", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    const deleted = writeAdapter
      ? await writeAdapter.deleteTask(userId, req.params.id)
      : memberWorkspaces.deleteTask(userId, req.params.id);
    if (!deleted) return res.status(404).json({ error: "Task not found" });
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

r.post("/notes", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    res.status(201).json(writeAdapter
      ? await writeAdapter.createNote(userId, req.body)
      : memberWorkspaces.createNote(userId, req.body));
  }
  catch (error) { sendError(res, error); }
});

r.patch("/notes/:id", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    const note = writeAdapter
      ? await writeAdapter.updateNote(userId, req.params.id, req.body)
      : memberWorkspaces.updateNote(userId, req.params.id, req.body);
    if (!note) return res.status(404).json({ error: "Note not found" });
    res.json(note);
  } catch (error) { sendError(res, error); }
});

r.delete("/notes/:id", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    const deleted = writeAdapter
      ? await writeAdapter.deleteNote(userId, req.params.id)
      : memberWorkspaces.deleteNote(userId, req.params.id);
    if (!deleted) return res.status(404).json({ error: "Note not found" });
    res.status(204).end();
  } catch (error) { sendError(res, error); }
});

r.get("/chat", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    const options = { after: req.query.after || "", limit: req.query.limit };
    res.json(readAdapter?.listChat
      ? await readAdapter.listChat(userId, options)
      : memberWorkspaces.listChat(userId, options));
  } catch (error) { sendError(res, error); }
});

r.post("/chat/sync", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    res.json(writeAdapter?.syncChat
      ? await writeAdapter.syncChat(userId, req.body)
      : memberWorkspaces.syncChat(userId, req.body));
  } catch (error) { sendError(res, error); }
});

r.delete("/chat", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    if (writeAdapter?.clearChat) await writeAdapter.clearChat(userId);
    else memberWorkspaces.clearChat(userId);
    res.status(204).end();
  } catch (error) { sendError(res, error); }
});

r.get("/inbox", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    const options = { status: req.query.status || "", limit: req.query.limit };
    const items = readAdapter?.listInbox
      ? await readAdapter.listInbox(userId, options)
      : memberWorkspaces.listInbox(userId, options);
    const unread = readAdapter?.unreadInboxCount
      ? await readAdapter.unreadInboxCount(userId)
      : memberWorkspaces.unreadInboxCount(userId);
    res.json({ items, unread });
  } catch (error) { sendError(res, error); }
});

r.post("/inbox", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    const input = { ...req.body, source: "mobile" };
    res.status(201).json(writeAdapter?.createInboxItem
      ? await writeAdapter.createInboxItem(userId, input)
      : memberWorkspaces.createInboxItem(userId, input));
  } catch (error) { sendError(res, error); }
});

r.post("/inbox/publish", async (req, res) => {
  try {
    const actor = currentUser(req);
    if (!new Set(["Creator", "Admin"]).has(actor.role)) {
      return res.status(403).json({ error: "Operator access required" });
    }
    const userId = String(req.body?.userId || "").trim();
    const target = userId === creatorUser().id ? creatorUser() : users.get(userId);
    if (!target || target.disabled) return res.status(404).json({ error: "User not found" });
    const input = { ...req.body, source: "hermes" };
    delete input.userId;
    res.status(201).json(writeAdapter?.createInboxItem
      ? await writeAdapter.createInboxItem(userId, input)
      : memberWorkspaces.createInboxItem(userId, input));
  } catch (error) { sendError(res, error); }
});

r.patch("/inbox/:id", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    const item = writeAdapter?.updateInboxItem
      ? await writeAdapter.updateInboxItem(userId, req.params.id, req.body)
      : memberWorkspaces.updateInboxItem(userId, req.params.id, req.body);
    if (!item) return res.status(404).json({ error: "Inbox item not found" });
    res.json(item);
  } catch (error) { sendError(res, error); }
});

export default r;
