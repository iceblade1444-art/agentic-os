import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { hardenRuntimeFile, notifyRuntimeFileMutation } from "./runtime-files.js";

const TASK_STATUSES = new Set(["todo", "doing", "done"]);
const PRIORITIES = new Set(["low", "normal", "high"]);
const MESSAGE_ROLES = new Set(["user", "assistant", "system"]);
const MESSAGE_SOURCES = new Set(["mobile", "web", "voice", "system", "hermes"]);
const INBOX_STATUSES = new Set(["unread", "read", "archived"]);
const INBOX_TYPES = new Set(["message", "reminder", "task", "calendar", "agent_result", "system"]);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CHAT_MESSAGES = 500;
const MAX_INBOX_ITEMS = 500;

const now = () => new Date().toISOString();
const clean = (value, max) => String(value || "").trim().slice(0, max);
const validDate = (value) => {
  const date = clean(value, 10);
  return !date || /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
};

function emptyWorkspace() {
  return { version: 2, tasks: [], notes: [], chatMessages: [], inboxItems: [], updatedAt: now() };
}

const validTimestamp = (value, fallback = now()) => {
  const text = clean(value, 40);
  const date = new Date(text);
  return text && !Number.isNaN(date.valueOf()) ? date.toISOString() : fallback;
};

const cleanId = (value, prefix) => {
  const id = clean(value, 120).replace(/[^a-zA-Z0-9:_-]/g, "");
  return id || `${prefix}_${crypto.randomUUID()}`;
};

function publicMessage(message = {}) {
  const timestamp = validTimestamp(message.createdAt);
  return {
    id: cleanId(message.id, "msg"),
    role: MESSAGE_ROLES.has(message.role) ? message.role : "assistant",
    text: clean(message.text, 20000),
    source: MESSAGE_SOURCES.has(message.source) ? message.source : "mobile",
    viaVoice: !!message.viaVoice,
    replyToText: clean(message.replyToText, 500),
    createdAt: timestamp,
    updatedAt: validTimestamp(message.updatedAt, timestamp),
  };
}

function publicInboxItem(item = {}) {
  const timestamp = validTimestamp(item.createdAt);
  const status = INBOX_STATUSES.has(item.status) ? item.status : "unread";
  return {
    id: cleanId(item.id, "inb"),
    type: INBOX_TYPES.has(item.type) ? item.type : "message",
    title: clean(item.title, 160),
    body: clean(item.body, 4000),
    status,
    priority: PRIORITIES.has(item.priority) ? item.priority : "normal",
    source: MESSAGE_SOURCES.has(item.source) ? item.source : "system",
    route: clean(item.route, 240),
    createdAt: timestamp,
    updatedAt: validTimestamp(item.updatedAt, timestamp),
    readAt: status === "unread" ? "" : validTimestamp(item.readAt, timestamp),
  };
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
        version: 2,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map(publicTask) : [],
        notes: Array.isArray(parsed.notes) ? parsed.notes.map(publicNote) : [],
        chatMessages: Array.isArray(parsed.chatMessages) ? parsed.chatMessages.map(publicMessage).slice(-MAX_CHAT_MESSAGES) : [],
        inboxItems: Array.isArray(parsed.inboxItems) ? parsed.inboxItems.map(publicInboxItem).slice(-MAX_INBOX_ITEMS) : [],
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
    const payload = {
      ...data,
      version: 2,
      chatMessages: (data.chatMessages || []).slice(-MAX_CHAT_MESSAGES),
      inboxItems: (data.inboxItems || []).slice(-MAX_INBOX_ITEMS),
      updatedAt: now(),
    };
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
    hardenRuntimeFile(file, 0o600);
    return payload;
  }

  remove(userId) {
    const file = this.fileFor(userId);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    notifyRuntimeFileMutation(file);
    return true;
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

  listChat(userId, { after = "", limit = 100 } = {}) {
    const bounded = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const messages = this.read(userId).chatMessages
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const filtered = after ? messages.filter((message) => message.updatedAt > after) : messages;
    return filtered.slice(-bounded);
  }

  syncChat(userId, input = {}) {
    const incoming = Array.isArray(input.messages) ? input.messages.slice(-200) : [];
    const data = this.read(userId);
    const byId = new Map(data.chatMessages.map((message) => [message.id, message]));
    for (const raw of incoming) {
      const message = publicMessage(raw);
      if (!message.text) continue;
      const existing = byId.get(message.id);
      if (!existing || message.updatedAt >= existing.updatedAt) byId.set(message.id, message);
    }
    data.chatMessages = [...byId.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-MAX_CHAT_MESSAGES);
    this.write(userId, data);
    return {
      messages: this.listChat(userId, { limit: 200 }),
      cursor: data.chatMessages.at(-1)?.updatedAt || "",
    };
  }

  clearChat(userId) {
    const data = this.read(userId);
    data.chatMessages = [];
    this.write(userId, data);
    return true;
  }

  listInbox(userId, { status = "", limit = 100 } = {}) {
    const bounded = Math.min(Math.max(Number(limit) || 100, 1), 200);
    return this.read(userId).inboxItems
      .filter((item) => !status || item.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, bounded);
  }

  createInboxItem(userId, input = {}) {
    const data = this.read(userId);
    const timestamp = now();
    const item = publicInboxItem({
      ...input,
      id: input.id || `inb_${crypto.randomUUID()}`,
      createdAt: input.createdAt || timestamp,
      updatedAt: timestamp,
    });
    if (!item.title && !item.body) {
      const error = new Error("Inbox item must contain a title or body");
      error.code = "invalid_inbox_item";
      error.status = 400;
      throw error;
    }
    const index = data.inboxItems.findIndex((entry) => entry.id === item.id);
    if (index >= 0) data.inboxItems[index] = item;
    else data.inboxItems.push(item);
    this.write(userId, data);
    return item;
  }

  updateInboxItem(userId, itemId, input = {}) {
    const data = this.read(userId);
    const item = data.inboxItems.find((entry) => entry.id === itemId);
    if (!item) return null;
    if (INBOX_STATUSES.has(input.status)) {
      item.status = input.status;
      item.readAt = input.status === "unread" ? "" : now();
    }
    item.updatedAt = now();
    this.write(userId, data);
    return publicInboxItem(item);
  }

  unreadInboxCount(userId) {
    return this.read(userId).inboxItems.filter((item) => item.status === "unread").length;
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
        unread: this.unreadInboxCount(userId),
      },
      tasks: tasks.filter((task) => task.status !== "done").slice(0, 6),
      notes: notes.slice(0, 5),
      inbox: this.listInbox(userId, { limit: 5 }),
      updatedAt: data.updatedAt,
    };
  }
}

export const memberWorkspaces = new MemberWorkspaceStore();
