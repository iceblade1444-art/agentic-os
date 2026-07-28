import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";

const MAX_SESSIONS_PER_USER = 50;
const clean = (value, limit) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);

function publicSession(session, currentId = "") {
  return {
    id: session.id,
    kind: session.kind,
    label: session.label,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    current: session.id === currentId,
  };
}

export class SessionStore {
  constructor(filePath = path.join(path.resolve(config.dataDir), "sessions.json")) {
    this.filePath = filePath;
    this.sessions = this.#load();
  }

  #load() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (!fs.existsSync(this.filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    } catch (error) {
      console.error("[sessions] load failed:", error.message);
      return [];
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, sessions: this.sessions }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    hardenRuntimeFile(this.filePath, 0o600);
  }

  #prune(now = Date.now()) {
    this.sessions = this.sessions.filter((session) =>
      !session.revokedAt && new Date(session.expiresAt).getTime() > now - 7 * 864e5);
  }

  create(userId, { kind = "web", label = "", expiresAt } = {}) {
    this.#prune();
    const now = new Date().toISOString();
    const session = {
      id: `ses_${crypto.randomUUID()}`,
      userId: clean(userId, 100),
      kind: kind === "mobile" ? "mobile" : "web",
      label: clean(label, 180) || (kind === "mobile" ? "MILA mobile" : "Web browser"),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(expiresAt || Date.now() + (kind === "mobile" ? 30 : 7) * 864e5).toISOString(),
      revokedAt: "",
    };
    this.sessions.push(session);
    const own = this.sessions.filter((item) => item.userId === session.userId);
    if (own.length > MAX_SESSIONS_PER_USER) {
      const remove = new Set(own.sort((a, b) => new Date(a.lastSeenAt) - new Date(b.lastSeenAt))
        .slice(0, own.length - MAX_SESSIONS_PER_USER).map((item) => item.id));
      this.sessions = this.sessions.filter((item) => !remove.has(item.id));
    }
    this.#save();
    return publicSession(session, session.id);
  }

  active(id, userId) {
    if (!id) return null;
    const session = this.sessions.find((item) => item.id === id && item.userId === userId);
    if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= Date.now()) return null;
    return session;
  }

  touch(id, userId) {
    const session = this.active(id, userId);
    if (!session) return false;
    if (Date.now() - new Date(session.lastSeenAt).getTime() >= 5 * 60 * 1000) {
      session.lastSeenAt = new Date().toISOString();
      this.#save();
    }
    return true;
  }

  list(userId, currentId = "") {
    this.#prune();
    return this.sessions
      .filter((session) => session.userId === userId && !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now())
      .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt))
      .map((session) => publicSession(session, currentId));
  }

  revoke(userId, id) {
    const session = this.sessions.find((item) => item.userId === userId && item.id === id && !item.revokedAt);
    if (!session) return null;
    session.revokedAt = new Date().toISOString();
    this.#save();
    return publicSession(session, id);
  }

  revokeOthers(userId, currentId) {
    let count = 0;
    for (const session of this.sessions) {
      if (session.userId === userId && session.id !== currentId && !session.revokedAt) {
        session.revokedAt = new Date().toISOString();
        count += 1;
      }
    }
    if (count) this.#save();
    return count;
  }

  removeUser(userId) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((session) => session.userId !== userId);
    if (this.sessions.length !== before) this.#save();
    return before - this.sessions.length;
  }
}

export const sessions = new SessionStore();
