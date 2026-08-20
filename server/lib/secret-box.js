// Encrypts the credential blobs that used to sit in data/db.json as plain text:
// OpenAI, Anthropic, GitHub, Notion, Slack, Postgres, Telegram and MILA admin
// tokens, protected by nothing but file permissions while the neighbouring
// governance store had used AES-256-GCM all along.
//
// The shape is deliberately the same as google-workspace.js — one derived key,
// GCM, iv.tag.body — so there is one encryption idiom in this codebase rather
// than three. Values are sealed on the way to disk and opened on the way back,
// which keeps every consumer of db.integrations reading a normal object.
import crypto from "node:crypto";

import { config } from "../config.js";

const MARKER = "__enc";

function keyFor(namespace, secret) {
  return crypto.createHash("sha256").update(`${namespace}:${secret}`).digest();
}

export function sealValue(value, namespace, secret = config.sessionSecret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(namespace, secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
}

export function openValue(sealed, namespace, secret = config.sessionSecret) {
  const [iv, tag, body] = String(sealed || "").split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFor(namespace, secret), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString());
}

export function isSealed(value) {
  return !!value && typeof value === "object" && typeof value[MARKER] === "string";
}

// Sealing under a per-process key would make the store unreadable after the
// next restart, so an install with no configured secret keeps writing plain
// objects. That install has authentication disabled anyway.
export function sealingAvailable(ephemeral = config.sessionSecretEphemeral) {
  return !ephemeral;
}

export function seal(value, namespace, { secret = config.sessionSecret, ephemeral = config.sessionSecretEphemeral } = {}) {
  if (!sealingAvailable(ephemeral)) return value;
  if (!value || typeof value !== "object" || !Object.keys(value).length) return value;
  return { [MARKER]: sealValue(value, namespace, secret) };
}

// Never throws: an unreadable blob means the key changed, and the caller needs
// a usable store plus a clear signal, not a crash loop at startup.
export function open(value, namespace, { secret = config.sessionSecret, onError } = {}) {
  if (!isSealed(value)) return value;
  try {
    return openValue(value[MARKER], namespace, secret);
  } catch (error) {
    onError?.(error);
    return {};
  }
}
