import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";

const TASK_STATUSES = new Set(["todo", "doing", "done"]);
const PRIORITIES = new Set(["low", "normal", "high"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const now = () => new Date().toISOString();
const clean = (value, max) => String(value || "").trim().slice(0, max);
const validDate = (value) => {
  const date = clean(value, 10);
  return !date || /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
};

function emptyWorkspace() {
  return { version: 1, tasks: [], notes: [], updatedAt: now() };
}

function publicTask(task) {
  return {
    id: task.id,
    title: task.title,
    detail: task.detail || "",
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate || "",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function publicNote(note) {
  return {
    id: note.id,
    title: note.title,
    content: note.content || "",
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function requiredTitle(value, entity) {
  const title = clean(value, 160);
  if (title.length < 2) {
    const error = new Error(`${entity} title must contain at least 2 characters`);
    error.code = "invalid_title";
    throw error;
  }
  return title;
}

export class MemberWorkspaceStore {
  constructor(baseDir = path.join(path.resolve(config.dataDir), "member-workspaces")) {
    this.baseDir = baseDir;
  }

  fileFor(userId) {
    const key = crypto.createHash("sha256").update(String(userId || "")).digest("hex");
    return path.join(this.baseDir, `${key}.json`);
  }

  read(userId) {
    const file = this.fileFor(userId);
    try {
      if (!fs.existsSync(file)) return emptyWorkspace();
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_BYTES) throw new Error("Member workspace exceeds the storage limit");
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        version: 1,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map(publicTask) : [],
        notes: Array.isArray(parsed.notes) ? parsed.notes.map(publicNote) : [],
        updatedAt: parsed.updatedAt || now(),
      };
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Member workspace data is corrupted");
      throw error;
    }
  }

  write(userId, data) {
    fs.mkdirSync(this.baseDir, { recursive: true });
    const file = this.fileFor(userId);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const payload = { ...data, version: 1, updatedAt: now() };
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
    hardenRuntimeFile(file, 0o600);
    return payload;
  }

  listTasks(userId) {
    return this.read(userId).tasks.sort((a, b) => {
      if (a.status !== b.status) return ["doing", "todo", "done"].indexOf(a.status) - ["doing", "todo", "done"].indexOf(b.status);
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  createTask(userId, input = {}) {
    const data = this.read(userId);
    const timestamp = now();
    const task = {
      id: `tsk_${crypto.randomUUID()}`,
      title: requiredTitle(input.title, "Task"),
      detail: clean(input.detail, 4000),
      status: TASK_STATUSES.has(input.status) ? input.status : "todo",
      priority: PRIORITIES.has(input.priority) ? input.priority : "normal",
      dueDate: validDate(input.dueDate),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    data.tasks.push(task);
    this.write(userId, data);
    return publicTask(task);
  }

  updateTask(userId, taskId, input = {}) {
    const data = this.read(userId);
    const task = data.tasks.find((item) => item.id === taskId);
    if (!task) return null;
    if (Object.hasOwn(input, "title")) task.title = requiredTitle(input.title, "Task");
    if (Object.hasOwn(input, "detail")) task.detail = clean(input.detail, 4000);
    if (TASK_STATUSES.has(input.status)) task.status = input.status;
    if (PRIORITIES.has(input.priority)) task.priority = input.priority;
    if (Object.hasOwn(input, "dueDate")) task.dueDate = validDate(input.dueDate);
    task.updatedAt = now();
    this.write(userId, data);
    return publicTask(task);
  }

  deleteTask(userId, taskId) {
    const data = this.read(userId);
    const next = data.tasks.filter((task) => task.id !== taskId);
    if (next.length === data.tasks.length) return false;
    data.tasks = next;
    this.write(userId, data);
    return true;
  }

  listNotes(userId) {
    return this.read(userId).notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  createNote(userId, input = {}) {
    const data = this.read(userId);
    const timestamp = now();
    const note = {
      id: `note_${crypto.randomUUID()}`,
      title: requiredTitle(input.title, "Note"),
      content: clean(input.content, 20000),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    data.notes.push(note);
    this.write(userId, data);
    return publicNote(note);
  }

  updateNote(userId, noteId, input = {}) {
    const data = this.read(userId);
    const note = data.notes.find((item) => item.id === noteId);
    if (!note) return null;
    if (Object.hasOwn(input, "title")) note.title = requiredTitle(input.title, "Note");
    if (Object.hasOwn(input, "content")) note.content = clean(input.content, 20000);
    note.updatedAt = now();
    this.write(userId, data);
    return publicNote(note);
  }

  deleteNote(userId, noteId) {
    const data = this.read(userId);
    const next = data.notes.filter((note) => note.id !== noteId);
    if (next.length === data.notes.length) return false;
    data.notes = next;
    this.write(userId, data);
    return true;
  }

  dashboard(userId) {
    const data = this.read(userId);
    const tasks = this.listTasks(userId);
    const notes = this.listNotes(userId);
    const today = new Date().toISOString().slice(0, 10);
    return {
      counts: {
        open: tasks.filter((task) => task.status !== "done").length,
        doing: tasks.filter((task) => task.status === "doing").length,
        due: tasks.filter((task) => task.status !== "done" && task.dueDate && task.dueDate <= today).length,
        notes: notes.length,
      },
      tasks: tasks.filter((task) => task.status !== "done").slice(0, 6),
      notes: notes.slice(0, 5),
      updatedAt: data.updatedAt,
    };
  }
}

export const memberWorkspaces = new MemberWorkspaceStore();
