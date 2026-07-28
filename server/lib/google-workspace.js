import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
];
const pending = new Map();
const file = path.join(config.dataDir, "google-workspace.json");
const key = crypto.createHash("sha256").update(`google-workspace:${config.sessionSecret}`).digest();

function load() {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function save(value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((item) => item.toString("base64url")).join(".");
}

function decrypt(value) {
  const [iv, tag, body] = String(value || "").split(".").map((item) => Buffer.from(item, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString());
}

function configured() {
  return !!(config.googleWorkspace.clientId && config.googleWorkspace.clientSecret && config.googleWorkspace.redirectUri);
}

function publicStatus(userId) {
  const record = load()[userId];
  return {
    configured: configured(),
    connected: !!record,
    scopes: record ? SCOPES.map((scope) => scope.split("/").at(-1)) : [],
    connectedAt: record?.connectedAt || null,
  };
}

async function tokenRequest(body) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error_description || value.error || "Google OAuth failed"), { status: 502 });
  return value;
}

export const googleWorkspace = {
  status: (userId) => publicStatus(userId),

  connect(userId) {
    if (!configured()) throw Object.assign(new Error("Google Workspace OAuth is not configured"), { status: 503 });
    const state = crypto.randomBytes(24).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    pending.set(state, { userId, verifier, expiresAt: Date.now() + 10 * 60 * 1000 });
    const query = new URLSearchParams({
      client_id: config.googleWorkspace.clientId,
      redirect_uri: config.googleWorkspace.redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      scope: SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return { authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query}` };
  },

  async callback(userId, code, state) {
    const request = pending.get(String(state || ""));
    pending.delete(String(state || ""));
    if (!request || request.userId !== userId || request.expiresAt < Date.now()) {
      throw Object.assign(new Error("Google OAuth request is invalid or expired"), { status: 400 });
    }
    const token = await tokenRequest({
      code: String(code || ""),
      client_id: config.googleWorkspace.clientId,
      client_secret: config.googleWorkspace.clientSecret,
      redirect_uri: config.googleWorkspace.redirectUri,
      grant_type: "authorization_code",
      code_verifier: request.verifier,
    });
    const records = load();
    records[userId] = {
      encrypted: encrypt(token),
      connectedAt: new Date().toISOString(),
    };
    save(records);
    return publicStatus(userId);
  },

  disconnect(userId) {
    const records = load();
    const record = records[userId];
    if (record) {
      try {
        const token = decrypt(record.encrypted);
        const revoke = token.refresh_token || token.access_token;
        if (revoke) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(revoke)}`, { method: "POST" }).catch(() => {});
      } catch {}
      delete records[userId];
      save(records);
    }
    return publicStatus(userId);
  },
};
