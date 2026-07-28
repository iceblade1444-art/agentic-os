import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import QRCode from "qrcode";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const SETUP_TTL_MS = 10 * 60 * 1000;
const RECOVERY_CODE_COUNT = 8;

function fail(message, code, status = 400) {
  throw Object.assign(new Error(message), { code, status });
}

function eligible(user) {
  return ["Creator", "Admin"].includes(user?.role);
}

function encryptionKey() {
  return crypto.createHash("sha256")
    .update(`agentic-os-mfa-v1:${config.sessionSecret}`)
    .digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decrypt(record) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(record.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function base32Encode(input) {
  const bytes = Buffer.from(input);
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let index = 0; index < bits.length; index += 5) {
    output += BASE32[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  }
  return output;
}

export function base32Decode(input) {
  const clean = String(input || "").toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = "";
  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index < 0) fail("Invalid MFA secret", "invalid_mfa_secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

export function totpCode(secret, timestamp = Date.now(), counterOffset = 0) {
  const counter = Math.floor(timestamp / 1000 / TOTP_STEP_SECONDS) + counterOffset;
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  ) % (10 ** TOTP_DIGITS);
  return { code: String(value).padStart(TOTP_DIGITS, "0"), counter };
}

function matchingCounter(secret, input, timestamp = Date.now()) {
  const code = String(input || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  for (const offset of [0, -1, 1]) {
    const candidate = totpCode(secret, timestamp, offset);
    if (crypto.timingSafeEqual(Buffer.from(code), Buffer.from(candidate.code))) return candidate.counter;
  }
  return null;
}

function recoveryValue() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  let value = "";
  for (const byte of bytes) value += alphabet[byte % alphabet.length];
  return `${value.slice(0, 5)}-${value.slice(5)}`;
}

function normalizeRecovery(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function recoveryDigest(userId, value) {
  return crypto.createHmac("sha256", config.sessionSecret)
    .update(`mfa-recovery:${userId}:${normalizeRecovery(value)}`)
    .digest("base64url");
}

function publicStatus(user, record) {
  return {
    eligible: eligible(user),
    enabled: !!record?.enabledAt,
    enabledAt: record?.enabledAt || "",
    recoveryCodesRemaining: Array.isArray(record?.recoveryCodes) ? record.recoveryCodes.length : 0,
  };
}

export class MfaStore {
  constructor(filePath = path.join(path.resolve(config.dataDir), "mfa.json")) {
    this.filePath = filePath;
    this.loadError = null;
    this.data = this.#load();
  }

  #load() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (!fs.existsSync(this.filePath)) return { version: 1, records: {} };
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return parsed?.records && typeof parsed.records === "object"
        ? { version: 1, records: parsed.records }
        : { version: 1, records: {} };
    } catch (error) {
      console.error("[mfa] load failed:", error.message);
      this.loadError = error;
      return { version: 1, records: {} };
    }
  }

  #save() {
    this.#assertReady();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    hardenRuntimeFile(this.filePath, 0o600);
  }

  #assertReady() {
    if (this.loadError) fail("MFA storage is unavailable", "mfa_store_unavailable", 503);
  }

  #record(user) {
    this.#assertReady();
    return this.data.records[String(user?.id || "")] || null;
  }

  status(user) {
    return publicStatus(user, this.#record(user));
  }

  enabled(user) {
    return eligible(user) && !!this.#record(user)?.enabledAt;
  }

  async begin(user) {
    if (!eligible(user)) fail("MFA is available only to Creator and Admin accounts", "mfa_not_eligible", 403);
    const existing = this.#record(user);
    if (existing?.enabledAt) fail("MFA is already enabled", "mfa_already_enabled", 409);
    const secret = base32Encode(crypto.randomBytes(20));
    const account = String(user.email || user.name || user.id).slice(0, 160);
    const label = encodeURIComponent(`Agentic OS:${account}`);
    const issuer = encodeURIComponent("Agentic OS");
    const otpauthUri = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
    this.data.records[user.id] = {
      pendingSecret: encrypt(secret),
      pendingExpiresAt: new Date(Date.now() + SETUP_TTL_MS).toISOString(),
      enabledAt: "",
      secret: null,
      lastCounter: -1,
      recoveryCodes: [],
    };
    this.#save();
    return {
      secret,
      otpauthUri,
      qrDataUrl: await QRCode.toDataURL(otpauthUri, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 240,
        color: { dark: "#111827", light: "#ffffff" },
      }),
      expiresInSeconds: SETUP_TTL_MS / 1000,
    };
  }

  confirm(user, code, timestamp = Date.now()) {
    const record = this.#record(user);
    if (!eligible(user) || !record?.pendingSecret) fail("Start MFA setup again", "mfa_setup_missing", 409);
    if (new Date(record.pendingExpiresAt).getTime() <= timestamp) {
      delete this.data.records[user.id];
      this.#save();
      fail("MFA setup has expired", "mfa_setup_expired", 410);
    }
    const secret = decrypt(record.pendingSecret);
    const counter = matchingCounter(secret, code, timestamp);
    if (counter === null) fail("The authenticator code is invalid", "invalid_mfa_code", 401);
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryValue);
    this.data.records[user.id] = {
      secret: encrypt(secret),
      enabledAt: new Date(timestamp).toISOString(),
      lastCounter: counter,
      recoveryCodes: recoveryCodes.map((value) => recoveryDigest(user.id, value)),
    };
    this.#save();
    return { ...publicStatus(user, this.#record(user)), recoveryCodes };
  }

  verify(user, input, timestamp = Date.now()) {
    const record = this.#record(user);
    if (!eligible(user) || !record?.enabledAt || !record.secret) return false;
    const normalizedRecovery = normalizeRecovery(input);
    if (normalizedRecovery.length === 10) {
      const digest = recoveryDigest(user.id, normalizedRecovery);
      const index = record.recoveryCodes.findIndex((value) =>
        value.length === digest.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(digest)));
      if (index < 0) return false;
      record.recoveryCodes.splice(index, 1);
      this.#save();
      return true;
    }
    const counter = matchingCounter(decrypt(record.secret), input, timestamp);
    if (counter === null || counter <= Number(record.lastCounter ?? -1)) return false;
    record.lastCounter = counter;
    this.#save();
    return true;
  }

  regenerateRecoveryCodes(user, code, timestamp = Date.now()) {
    if (!this.verify(user, code, timestamp)) fail("The authenticator or recovery code is invalid", "invalid_mfa_code", 401);
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryValue);
    const record = this.#record(user);
    record.recoveryCodes = recoveryCodes.map((value) => recoveryDigest(user.id, value));
    this.#save();
    return { ...publicStatus(user, record), recoveryCodes };
  }

  disable(user, code, timestamp = Date.now()) {
    if (!this.verify(user, code, timestamp)) fail("The authenticator or recovery code is invalid", "invalid_mfa_code", 401);
    delete this.data.records[user.id];
    this.#save();
    return publicStatus(user, null);
  }

  removeUser(userId) {
    this.#assertReady();
    if (!this.data.records[String(userId)]) return false;
    delete this.data.records[String(userId)];
    this.#save();
    return true;
  }
}

export const mfa = new MfaStore();
