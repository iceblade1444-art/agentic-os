import path from "node:path";

import pg from "pg";

import { buildPostgresMigrationPlan } from "./postgres-migration.js";

const { Pool } = pg;
const SCHEMA = "agentic_os_shadow";
const MIGRATION_LOCK = 1447145031;
const MODES = new Set(["json", "shadow", "primary"]);
const GROUP_BY_FILE = new Map([
  ["users.json", "users"],
  ["sessions.json", "sessions"],
  ["mfa.json", "mfaRecords"],
  ["account-tokens.json", "accountTokens"],
]);

const cleanError = (error, databaseUrl = "") => {
  let message = String(error?.message || error || "PostgreSQL auth write failed");
  if (databaseUrl) message = message.replaceAll(databaseUrl, "[database]");
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database]")
    .replace(/(password\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 200);
};

export class PostgresAuthWriteAdapter {
  constructor({
    mode = "json",
    dataDir,
    databaseUrl = "",
    shadowStatus = () => ({ status: "disabled" }),
    pool = null,
  } = {}) {
    this.mode = MODES.has(mode) ? mode : "json";
    this.dataDir = path.resolve(dataDir || ".");
    this.databaseUrl = databaseUrl;
    this.shadowStatus = shadowStatus;
    this.primary = this.mode === "primary";
    this.enabled = this.mode !== "json" && !!databaseUrl;
    this.ownedPool = !pool && this.enabled;
    this.pool = pool || (this.enabled ? new Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 1500,
      idleTimeoutMillis: 10000,
      statement_timeout: 4000,
      query_timeout: 5000,
    }) : null);
    this.operations = new Map();
    this.activeGroups = new Set();
    this.metrics = {
      jsonWrites: 0,
      postgresWrites: 0,
      fallbackWrites: 0,
      gateFallbacks: 0,
      queryFallbacks: 0,
      lastWriteAt: null,
      lastGroup: null,
      lastFallbackReason: null,
      error: null,
    };
    if (typeof this.pool?.on === "function") {
      this.pool.on("error", (error) => {
        this.metrics.error = cleanError(error, this.databaseUrl);
      });
    }
  }

  status() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      primary: this.primary,
      pendingGroups: this.activeGroups.size,
      ...this.metrics,
    };
  }

  request(file) {
    const group = this.#group(file);
    if (!group) return false;
    this.metrics.jsonWrites += 1;
    this.metrics.lastWriteAt = new Date().toISOString();
    this.metrics.lastGroup = group;
    if (!this.enabled) return true;

    if (!this.primary && this.shadowStatus().status !== "ready") {
      this.#fallback("gate", "shadow_not_ready");
      return true;
    }

    const previous = this.operations.get(group) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.#sync(group));
    this.operations.set(group, current);
    this.activeGroups.add(group);
    current
      .then(() => {
        this.metrics.postgresWrites += 1;
        this.metrics.lastFallbackReason = null;
        this.metrics.error = null;
      })
      .catch((error) => {
        this.metrics.error = cleanError(error, this.databaseUrl);
        this.#fallback("query", "query_error");
      })
      .finally(() => {
        if (this.operations.get(group) === current) this.activeGroups.delete(group);
      });
    return true;
  }

  async commit(groups = []) {
    if (!this.primary) return { required: false };
    const selected = (groups.length ? groups : [...this.operations.keys()])
      .map((group) => this.operations.get(group))
      .filter(Boolean);
    if (!selected.length) return { required: true, committed: 0 };
    try {
      await Promise.all(selected);
      return { required: true, committed: selected.length };
    } catch (cause) {
      const error = new Error(`Could not commit account change: ${cleanError(cause, this.databaseUrl)}`);
      error.code = "postgres_commit_failed";
      error.status = 503;
      throw error;
    }
  }

  async stop() {
    await Promise.allSettled([...this.operations.values()]);
    if (this.ownedPool && this.pool) await this.pool.end();
  }

  #group(file) {
    const relative = path.relative(this.dataDir, path.resolve(file)).replaceAll("\\", "/");
    return GROUP_BY_FILE.get(relative) || "";
  }

  #fallback(kind, reason) {
    this.metrics.fallbackWrites += 1;
    this.metrics[`${kind}Fallbacks`] += 1;
    this.metrics.lastFallbackReason = reason;
  }

  async #sync(group) {
    const rows = buildPostgresMigrationPlan(this.dataDir).rows[group];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      if (group === "users") await this.#replaceUsers(client, rows);
      else if (group === "sessions") await this.#replaceSessions(client, rows);
      else if (group === "mfaRecords") await this.#replaceMfa(client, rows);
      else if (group === "accountTokens") await this.#replaceTokens(client, rows);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async #replaceUsers(client, rows) {
    await client.query(`DELETE FROM ${SCHEMA}.users`);
    for (const user of rows) {
      await client.query(
        `INSERT INTO ${SCHEMA}.users
         (id,name,email,role,avatar,disabled,salt,password_hash,session_version,email_verified_at,created_at,updated_at,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [user.id, user.name, user.email, user.role, user.avatar || "", !!user.disabled,
          user.salt, user.passwordHash, Number(user.sessionVersion) || 1,
          user.emailVerifiedAt || null, user.createdAt, user.updatedAt, user],
      );
    }
  }

  async #replaceSessions(client, rows) {
    await client.query(`DELETE FROM ${SCHEMA}.sessions`);
    for (const session of rows) {
      await client.query(
        `INSERT INTO ${SCHEMA}.sessions
         (id,user_id,kind,label,created_at,last_seen_at,expires_at,revoked_at,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [session.id, session.userId, session.kind, session.label, session.createdAt,
          session.lastSeenAt, session.expiresAt, session.revokedAt || null, session],
      );
    }
  }

  async #replaceMfa(client, rows) {
    await client.query(`DELETE FROM ${SCHEMA}.mfa_records`);
    for (const item of rows) {
      await client.query(
        `INSERT INTO ${SCHEMA}.mfa_records (user_id,payload,enabled_at) VALUES ($1,$2,$3)`,
        [item.userId, item.record, item.record.enabledAt || null],
      );
    }
  }

  async #replaceTokens(client, rows) {
    await client.query(`DELETE FROM ${SCHEMA}.account_tokens`);
    for (const token of rows) {
      await client.query(
        `INSERT INTO ${SCHEMA}.account_tokens
         (digest,user_id,purpose,created_at,expires_at,payload) VALUES ($1,$2,$3,$4,$5,$6)`,
        [token.digest, token.userId, token.purpose, token.createdAt, token.expiresAt, token],
      );
    }
  }
}
