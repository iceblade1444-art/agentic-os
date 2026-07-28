import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { hardenRuntimeFile } from "./runtime-files.js";

const MAX_OUTBOX_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 10000;
const ROOT_FILES = new Set([
  "users.json",
  "sessions.json",
  "onboarding.json",
  "mfa.json",
  "account-tokens.json",
]);

const cleanError = (error) => String(error?.message || error || "Unknown outbox error").slice(0, 200);

function safeRelative(dataDir, file) {
  const relative = path.relative(path.resolve(dataDir), path.resolve(file)).replaceAll("\\", "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) return "";
  if (ROOT_FILES.has(relative)) return relative;
  if (/^member-workspaces\/[a-f0-9]{64}\.json$/.test(relative)) return relative;
  return "";
}

export class PostgresShadowOutbox {
  constructor({
    dataDir,
    filePath = path.join(path.resolve(dataDir), "postgres-shadow-outbox.jsonl"),
  } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.filePath = path.resolve(filePath);
    this.readError = null;
    this.writeError = null;
  }

  record(file) {
    const relativeFile = safeRelative(this.dataDir, file);
    if (!relativeFile) return false;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size >= MAX_OUTBOX_BYTES) {
        this.#compact();
      }
      const event = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        file: relativeFile,
      };
      fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      hardenRuntimeFile(this.filePath, 0o600);
      this.writeError = null;
      return true;
    } catch (error) {
      this.writeError = cleanError(error);
      console.error(`[postgres-outbox] append failed: ${this.writeError}`);
      return false;
    }
  }

  snapshot() {
    try {
      const events = this.#read();
      this.readError = null;
      return events;
    } catch (error) {
      this.readError = cleanError(error);
      console.error(`[postgres-outbox] read failed: ${this.readError}`);
      return [];
    }
  }

  acknowledge(eventIds = []) {
    const ids = new Set(eventIds.map(String));
    if (!ids.size) return 0;
    try {
      const events = this.#read();
      const remaining = events.filter((event) => !ids.has(event.id));
      this.#rewrite(remaining);
      this.writeError = null;
      return events.length - remaining.length;
    } catch (error) {
      this.writeError = cleanError(error);
      console.error(`[postgres-outbox] acknowledge failed: ${this.writeError}`);
      return 0;
    }
  }

  status() {
    const events = this.snapshot();
    let bytes = 0;
    try { bytes = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0; } catch { /* bounded status only */ }
    return {
      pending: events.length,
      oldestAt: events[0]?.createdAt || null,
      bytes,
      error: this.writeError || this.readError,
    };
  }

  #read() {
    if (!fs.existsSync(this.filePath)) return [];
    const stat = fs.statSync(this.filePath);
    if (stat.size > MAX_OUTBOX_BYTES * 2) throw new Error("PostgreSQL outbox exceeds the recovery limit");
    return fs.readFileSync(this.filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-MAX_EVENTS)
      .map((line) => JSON.parse(line))
      .filter((event) =>
        typeof event?.id === "string"
        && typeof event?.createdAt === "string"
        && typeof event?.file === "string");
  }

  #compact() {
    const latestByFile = new Map();
    for (const event of this.#read()) latestByFile.set(event.file, event);
    this.#rewrite([...latestByFile.values()]);
  }

  #rewrite(events) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const body = events.length ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "";
    fs.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    hardenRuntimeFile(this.filePath, 0o600);
  }
}
