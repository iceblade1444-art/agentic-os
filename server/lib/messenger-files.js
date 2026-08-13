// Attachments for the corporate chat.
//
// Files belong to a conversation, not to a person, because that is what decides
// who may read them: the route checks membership and nothing else grants access.
// Names are never used as paths — a stored file is `<uuid>.bin` and the original
// name is metadata — so a colleague sending "../../.env" as a filename cannot
// reach anything.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";

// A phone photo or a minute of voice fits; a video does not, on purpose — the
// server holds this on the same disk the database and the vault live on.
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_PER_CONVERSATION = 2000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic"]);
const AUDIO_TYPES = new Set(["audio/ogg", "audio/webm", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav"]);

const clean = (value, max) => String(value ?? "").trim().slice(0, max);

function kindOf(type) {
  if (IMAGE_TYPES.has(type)) return "image";
  if (AUDIO_TYPES.has(type) || type.startsWith("audio/")) return "audio";
  return "file";
}

function displayName(value, kind) {
  const raw = path.basename(String(value || "")).replace(/[^\p{L}\p{N}._() -]/gu, "_").slice(0, 140);
  if (raw && raw !== "." && raw !== "..") return raw;
  return kind === "image" ? "image" : kind === "audio" ? "voice" : "file";
}

export class MessengerFiles {
  constructor(baseDir = path.join(path.resolve(config.dataDir), "messenger-files")) {
    this.baseDir = baseDir;
  }

  // Rejected rather than sanitised: quietly turning "../../etc" into "etc" would
  // write real files to a folder nobody asked for instead of failing.
  #folder(conversationId) {
    const id = String(conversationId ?? "");
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw Object.assign(new Error("Invalid conversation id"), { status: 400 });
    }
    return path.join(this.baseDir, id);
  }

  #indexFile(conversationId) {
    return path.join(this.#folder(conversationId), "index.json");
  }

  #read(conversationId) {
    try {
      const value = JSON.parse(fs.readFileSync(this.#indexFile(conversationId), "utf8"));
      return Array.isArray(value.files) ? value.files : [];
    } catch {
      return [];
    }
  }

  #write(conversationId, files) {
    const folder = this.#folder(conversationId);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = this.#indexFile(conversationId);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, files }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    hardenRuntimeFile(file, 0o600);
  }

  add(conversationId, input = {}) {
    const files = this.#read(conversationId);
    if (files.length >= MAX_PER_CONVERSATION) {
      throw Object.assign(new Error("This conversation has reached its attachment limit"), { status: 409 });
    }
    const buffer = Buffer.from(String(input.base64 || ""), "base64");
    if (!buffer.length) throw Object.assign(new Error("The file is empty"), { status: 400 });
    if (buffer.length > MAX_BYTES) {
      throw Object.assign(new Error("The file is larger than 12 MB"), { status: 413 });
    }
    const type = clean(input.type, 100) || "application/octet-stream";
    const kind = kindOf(type);
    const id = crypto.randomUUID();
    const folder = this.#folder(conversationId);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(folder, `${id}.bin`), buffer, { mode: 0o600 });

    const item = {
      id,
      name: displayName(input.name, kind),
      type,
      kind,
      size: buffer.length,
      // Set by the caller for voice notes; the recogniser runs elsewhere.
      duration: Number(input.duration) > 0 ? Math.round(Number(input.duration)) : 0,
      transcript: clean(input.transcript, 2000),
      createdAt: new Date().toISOString(),
    };
    files.push(item);
    this.#write(conversationId, files);
    return item;
  }

  get(conversationId, fileId) {
    const item = this.#read(conversationId).find((file) => file.id === fileId);
    if (!item) throw Object.assign(new Error("File not found"), { status: 404 });
    const stored = path.join(this.#folder(conversationId), `${item.id}.bin`);
    return { ...item, buffer: fs.readFileSync(stored) };
  }

  removeConversation(conversationId) {
    fs.rmSync(this.#folder(conversationId), { recursive: true, force: true });
  }
}

export const messengerFiles = new MessengerFiles();
