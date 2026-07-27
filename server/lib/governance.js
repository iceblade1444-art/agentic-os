import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,79}$/;
const MAX_SECRET_LENGTH = 64 * 1024;
const MAX_RUNS = 100;
const MAX_AUDIT = 500;

function emptyData() {
  return { version: 1, secrets: [], evaluations: [], audit: [] };
}

const timestamp = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const clean = (value, max) => String(value || "").trim().slice(0, max);

function fail(message, code, status = 400) {
  throw Object.assign(new Error(message), { code, status });
}

function encryptionKey() {
  return crypto.createHash("sha256")
    .update(`agentic-os-governance-v1:${config.sessionSecret}`)
    .digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: encrypted.toString("base64url"),
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

function publicSecret(secret) {
  return {
    id: secret.id,
    name: secret.name,
    description: secret.description || "",
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
    hasValue: !!secret.ciphertext,
  };
}

export function activeGuardrails() {
  return [
    {
      id: "operator-rbac",
      name: "Operator role isolation",
      description: "Creator/Admin routes reject Member and Viewer sessions.",
      active: true,
      enforcement: "server",
    },
    {
      id: "member-data-isolation",
      name: "Member data isolation",
      description: "Personal tasks, notes, onboarding and SOUL are scoped by user ID.",
      active: true,
      enforcement: "server",
    },
    {
      id: "write-only-secrets",
      name: "Write-only secret values",
      description: "Secret values are encrypted at rest and never returned by the API.",
      active: true,
      enforcement: "server",
    },
    {
      id: "api-rate-limits",
      name: "API rate limits",
      description: "Authentication, registration and protected APIs have server-side request limits.",
      active: true,
      enforcement: "server",
    },
    {
      id: "human-approval",
      name: "Human approval gates",
      description: "Hermes can pause consequential work in the approval queue.",
      active: true,
      enforcement: "hermes",
    },
    {
      id: "custom-mcp-policy",
      name: "Custom MCP policy",
      description: config.allowCustomMcp
        ? "Custom MCP servers are explicitly enabled by server configuration."
        : "Unapproved custom MCP server creation is disabled.",
      active: true,
      enforcement: "configuration",
    },
  ];
}

export class GovernanceStore {
  constructor(filePath = path.join(path.resolve(config.dataDir), "governance.json")) {
    this.filePath = filePath;
    this.data = this.#load();
  }

  #load() {
    try {
      if (!fs.existsSync(this.filePath)) return emptyData();
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        version: 1,
        secrets: Array.isArray(parsed?.secrets) ? parsed.secrets : [],
        evaluations: Array.isArray(parsed?.evaluations) ? parsed.evaluations.slice(0, MAX_RUNS) : [],
        audit: Array.isArray(parsed?.audit) ? parsed.audit.slice(0, MAX_AUDIT) : [],
      };
    } catch (error) {
      console.error("[governance] load failed:", error.message);
      return emptyData();
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    hardenRuntimeFile(this.filePath, 0o600);
  }

  #audit(action, actor, target, detail = "") {
    this.data.audit.unshift({
      id: uid("audit"),
      action: clean(action, 80),
      actor: clean(actor || "Agentic OS", 120),
      target: clean(target, 160),
      detail: clean(detail, 500),
      at: timestamp(),
    });
    this.data.audit = this.data.audit.slice(0, MAX_AUDIT);
  }

  listSecrets() {
    return this.data.secrets.map(publicSecret).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  setSecret(input = {}, actor = "") {
    const name = clean(input.name, 80).toUpperCase();
    const value = String(input.value || "");
    const description = clean(input.description, 300);
    if (!SECRET_NAME.test(name)) fail("Use 2-80 uppercase letters, numbers or underscores", "invalid_secret_name");
    if (!value) fail("Secret value is required", "missing_secret_value");
    if (Buffer.byteLength(value, "utf8") > MAX_SECRET_LENGTH) fail("Secret value is too large", "secret_too_large", 413);
    const now = timestamp();
    let record = this.data.secrets.find((item) => item.name === name);
    if (!record) {
      record = { id: uid("sec"), name, createdAt: now };
      this.data.secrets.push(record);
    }
    Object.assign(record, encrypt(value), { description, updatedAt: now });
    this.#audit("secret.upsert", actor, name, record.createdAt === now ? "created" : "rotated");
    this.#save();
    return publicSecret(record);
  }

  removeSecret(id, actor = "") {
    const index = this.data.secrets.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const [removed] = this.data.secrets.splice(index, 1);
    this.#audit("secret.delete", actor, removed.name);
    this.#save();
    return publicSecret(removed);
  }

  value(name) {
    const record = this.data.secrets.find((item) => item.name === String(name || "").toUpperCase());
    return record ? decrypt(record) : null;
  }

  listEvaluations() {
    const runs = this.data.evaluations.slice();
    const totalCases = runs.reduce((sum, run) => sum + run.cases, 0);
    const passed = runs.filter((run) => run.pass).length;
    const average = runs.length
      ? Math.round((runs.reduce((sum, run) => sum + run.score, 0) / runs.length) * 10) / 10
      : null;
    return {
      summary: {
        runs: runs.length,
        average,
        passRate: runs.length ? Math.round((passed / runs.length) * 100) : null,
        totalCases,
        regressions: runs.filter((run) => !run.pass).length,
      },
      runs,
    };
  }

  recordEvaluation(readiness, actor = "") {
    const checks = (readiness.sections || []).flatMap((section) =>
      (section.checks || []).map((check) => ({
        section: section.label,
        id: check.id,
        label: check.label,
        ok: check.ok === true,
        detail: clean(check.detail, 240),
      })));
    const run = {
      id: uid("eval"),
      name: "Production readiness",
      agent: "Agentic OS",
      framework: readiness.framework || "Four C",
      score: Math.max(0, Math.min(100, Number(readiness.score) || 0)),
      pass: Number(readiness.score) >= 80,
      cases: checks.length,
      passedCases: checks.filter((check) => check.ok).length,
      status: readiness.status || "blocked",
      checks,
      at: timestamp(),
    };
    this.data.evaluations.unshift(run);
    this.data.evaluations = this.data.evaluations.slice(0, MAX_RUNS);
    this.#audit("evaluation.run", actor, run.id, `${run.score}% (${run.passedCases}/${run.cases})`);
    this.#save();
    return run;
  }

  audit(limit = 100) {
    return this.data.audit.slice(0, Math.max(1, Math.min(200, Number(limit) || 100)));
  }
}

export const governance = new GovernanceStore();
