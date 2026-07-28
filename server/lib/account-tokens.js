import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";

const PURPOSES = new Set(["verify_email", "reset_password"]);

export class AccountTokenStore {
  constructor(filePath = path.join(path.resolve(config.dataDir), "account-tokens.json")) {
    this.filePath = filePath;
    this.tokens = this.#load();
  }

  #load() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (!fs.existsSync(this.filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return Array.isArray(parsed?.tokens) ? parsed.tokens : [];
    } catch (error) {
      console.error("[account-tokens] load failed:", error.message);
      return [];
    }
  }

  #digest(value) {
    return crypto.createHmac("sha256", config.sessionSecret).update(String(value)).digest("base64url");
  }

  #save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, tokens: this.tokens }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    hardenRuntimeFile(this.filePath, 0o600);
  }

  #prune() {
    const now = Date.now();
    this.tokens = this.tokens.filter((token) => new Date(token.expiresAt).getTime() > now);
  }

  create(userId, purpose, ttlMs) {
    if (!PURPOSES.has(purpose)) throw new Error("Unsupported account token purpose");
    this.#prune();
    this.tokens = this.tokens.filter((token) => !(token.userId === userId && token.purpose === purpose));
    const raw = crypto.randomBytes(32).toString("base64url");
    this.tokens.push({
      digest: this.#digest(raw),
      userId: String(userId),
      purpose,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    });
    this.#save();
    return raw;
  }

  consume(raw, purpose) {
    this.#prune();
    const digest = this.#digest(raw);
    const index = this.tokens.findIndex((token) => token.digest === digest && token.purpose === purpose);
    if (index < 0) {
      this.#save();
      return null;
    }
    const [token] = this.tokens.splice(index, 1);
    this.#save();
    return token.userId;
  }

  removeUser(userId) {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((token) => token.userId !== userId);
    if (before !== this.tokens.length) this.#save();
    return before - this.tokens.length;
  }
}

export const accountTokens = new AccountTokenStore();
