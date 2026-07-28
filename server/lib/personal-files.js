import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";

const MAX_BYTES = 600 * 1024;
const MAX_FILES = 100;
const root = path.join(config.dataDir, "personal-files");

const userKey = (userId) => crypto.createHash("sha256").update(String(userId)).digest("hex");
const folder = (userId) => path.join(root, userKey(userId));
const indexFile = (userId) => path.join(folder(userId), "index.json");

function read(userId) {
  try {
    const value = JSON.parse(fs.readFileSync(indexFile(userId), "utf8"));
    return Array.isArray(value.files) ? value.files : [];
  } catch {
    return [];
  }
}

function write(userId, files) {
  fs.mkdirSync(folder(userId), { recursive: true, mode: 0o700 });
  fs.writeFileSync(indexFile(userId), JSON.stringify({ version: 1, files }, null, 2) + "\n", { mode: 0o600 });
}

function safeName(value) {
  const name = path.basename(String(value || "")).replace(/[^\p{L}\p{N}._() -]/gu, "_").slice(0, 140);
  if (!name || name === "." || name === "..") throw Object.assign(new Error("A valid filename is required"), { status: 400 });
  return name;
}

export const personalFiles = {
  list(userId) {
    return read(userId).map(({ storageName: _storageName, ...item }) => item);
  },

  add(userId, input = {}) {
    const files = read(userId);
    if (files.length >= MAX_FILES) throw Object.assign(new Error("Personal file limit reached"), { status: 409 });
    const name = safeName(input.name);
    const type = String(input.type || "application/octet-stream").slice(0, 100);
    const buffer = Buffer.from(String(input.base64 || ""), "base64");
    if (!buffer.length) throw Object.assign(new Error("File is empty"), { status: 400 });
    if (buffer.length > MAX_BYTES) throw Object.assign(new Error("File exceeds the 600 KB personal-library limit"), { status: 413 });
    const id = crypto.randomUUID();
    const storageName = `${id}.bin`;
    fs.mkdirSync(folder(userId), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(folder(userId), storageName), buffer, { mode: 0o600 });
    const item = { id, name, type, size: buffer.length, createdAt: new Date().toISOString(), storageName };
    files.push(item);
    write(userId, files);
    const { storageName: _storageName, ...publicItem } = item;
    return publicItem;
  },

  get(userId, id) {
    const item = read(userId).find((entry) => entry.id === id);
    if (!item) throw Object.assign(new Error("File not found"), { status: 404 });
    return { ...item, buffer: fs.readFileSync(path.join(folder(userId), item.storageName)) };
  },

  remove(userId, id) {
    const files = read(userId);
    const item = files.find((entry) => entry.id === id);
    if (!item) throw Object.assign(new Error("File not found"), { status: 404 });
    fs.rmSync(path.join(folder(userId), item.storageName), { force: true });
    write(userId, files.filter((entry) => entry.id !== id));
    return { ok: true };
  },

  removeUser(userId) {
    fs.rmSync(folder(userId), { recursive: true, force: true });
  },
};
