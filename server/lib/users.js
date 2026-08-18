import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";
import { ASSIGNABLE_ROLE_SET, rolesSentence } from "./roles.js";

const ROLES = ASSIGNABLE_ROLE_SET;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatar: user.avatar || "",
    disabled: !!user.disabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    emailVerified: user.emailVerifiedAt !== "",
    // Accounts created before approval existed have no approvedAt and stay approved.
    approved: user.approvedAt !== "",
    approvedAt: user.approvedAt || "",
  };
}

function fail(message, code = "invalid_user") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export class UserStore {
  constructor(filePath = path.join(path.resolve(config.dataDir), "users.json")) {
    this.filePath = filePath;
    this.users = this.#load();
  }

  #load() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (!fs.existsSync(this.filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return Array.isArray(parsed?.users) ? parsed.users : [];
    } catch (error) {
      console.error("[users] load failed:", error.message);
      return [];
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, users: this.users }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    hardenRuntimeFile(this.filePath, 0o600);
  }

  list() {
    return this.users.map(publicUser);
  }

  get(id) {
    return publicUser(this.users.find((user) => user.id === id));
  }

  sessionUser(id) {
    const user = this.users.find((item) => item.id === id);
    if (!user || user.disabled || user.approvedAt === "") return null;
    return { ...publicUser(user), sessionVersion: Number(user.sessionVersion) || 1 };
  }

  register(input = {}) {
    const name = String(input.name || "").trim().slice(0, 120);
    const email = String(input.email || "").trim().toLowerCase().slice(0, 200);
    const password = String(input.password || "");
    if (name.length < 2) fail("Name must contain at least 2 characters");
    if (!EMAIL_RE.test(email)) fail("Enter a valid email address");
    if (password.length < 10) fail("Password must contain at least 10 characters", "weak_password");
    if (password.length > 256) fail("Password is too long", "weak_password");
    if (this.users.some((user) => user.email === email)) fail("An account with this email already exists", "email_exists");

    const salt = crypto.randomBytes(16).toString("base64url");
    const passwordHash = crypto.scryptSync(password, salt, 64).toString("base64url");
    const now = new Date().toISOString();
    const user = {
      id: `usr_${crypto.randomUUID()}`,
      name,
      email,
      role: "Member",
      avatar: "",
      disabled: false,
      salt,
      passwordHash,
      sessionVersion: 1,
      emailVerifiedAt: input.emailVerified === false ? "" : now,
      approvedAt: input.requiresApproval ? "" : now,
      createdAt: now,
      updatedAt: now,
    };
    this.users.push(user);
    this.#save();
    return { ...publicUser(user), sessionVersion: 1 };
  }

  // Returns a pending account too, so the caller can say "waiting for approval"
  // instead of "wrong password". Only sessionUser() gates on approval.
  authenticate(emailInput, passwordInput) {
    const email = String(emailInput || "").trim().toLowerCase();
    const password = String(passwordInput || "");
    const user = this.users.find((item) => item.email === email);
    if (!user || user.disabled || !password) return null;
    const actual = crypto.scryptSync(password, user.salt, 64);
    const expected = Buffer.from(user.passwordHash, "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    return { ...publicUser(user), sessionVersion: Number(user.sessionVersion) || 1 };
  }

  findByEmail(emailInput) {
    const email = String(emailInput || "").trim().toLowerCase();
    return publicUser(this.users.find((item) => item.email === email));
  }

  markEmailVerified(id) {
    const user = this.users.find((item) => item.id === id);
    if (!user) return null;
    user.emailVerifiedAt = new Date().toISOString();
    user.updatedAt = user.emailVerifiedAt;
    this.#save();
    return publicUser(user);
  }

  setPassword(id, passwordInput) {
    const user = this.users.find((item) => item.id === id);
    if (!user) return null;
    const password = String(passwordInput || "");
    if (password.length < 10) fail("Password must contain at least 10 characters", "weak_password");
    if (password.length > 256) fail("Password is too long", "weak_password");
    user.salt = crypto.randomBytes(16).toString("base64url");
    user.passwordHash = crypto.scryptSync(password, user.salt, 64).toString("base64url");
    user.sessionVersion = (Number(user.sessionVersion) || 1) + 1;
    user.updatedAt = new Date().toISOString();
    this.#save();
    return publicUser(user);
  }

  update(id, patch = {}) {
    const user = this.users.find((item) => item.id === id);
    if (!user) return null;
    let revokeSessions = false;
    if (patch.role !== undefined) {
      const role = String(patch.role);
      if (!ROLES.has(role)) fail(`Role must be ${rolesSentence()}`, "invalid_role");
      if (role !== user.role) { user.role = role; revokeSessions = true; }
    }
    if (patch.disabled !== undefined && !!patch.disabled !== !!user.disabled) {
      user.disabled = !!patch.disabled;
      revokeSessions = true;
    }
    if (patch.approved !== undefined) {
      const approved = !!patch.approved;
      if (approved !== (user.approvedAt !== "")) {
        user.approvedAt = approved ? new Date().toISOString() : "";
        revokeSessions = true;
      }
    }
    if (revokeSessions) user.sessionVersion = (Number(user.sessionVersion) || 1) + 1;
    user.updatedAt = new Date().toISOString();
    this.#save();
    return publicUser(user);
  }

  remove(id) {
    const index = this.users.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const [removed] = this.users.splice(index, 1);
    this.#save();
    return publicUser(removed);
  }
}

export const users = new UserStore();
