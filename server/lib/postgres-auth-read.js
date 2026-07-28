import crypto from "node:crypto";

import pg from "pg";

const { Pool } = pg;
const MODES = new Set(["json", "canary", "postgres"]);

const cleanError = (error, databaseUrl = "") => {
  let message = String(error?.message || error || "PostgreSQL auth read failed");
  if (databaseUrl) message = message.replaceAll(databaseUrl, "[database]");
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database]").slice(0, 200);
};

const publicUser = (user) => user ? ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  avatar: user.avatar || "",
  disabled: !!user.disabled,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  emailVerified: user.emailVerifiedAt !== "",
}) : null;

const sessionUser = (user) => {
  if (!user || user.disabled) return null;
  return { ...publicUser(user), sessionVersion: Number(user.sessionVersion) || 1 };
};

const publicSession = (session, currentId = "") => ({
  id: session.id,
  kind: session.kind,
  label: session.label,
  createdAt: session.createdAt,
  lastSeenAt: session.lastSeenAt,
  expiresAt: session.expiresAt,
  current: session.id === currentId,
});

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export class PostgresAuthReadAdapter {
  constructor({
    mode = "json",
    databaseUrl = "",
    shadowStatus = () => ({ status: "disabled", outbox: { pending: 0 } }),
    userStore,
    sessionStore,
    refreshMs = 1000,
    cacheMaxAgeMs,
    pool = null,
  } = {}) {
    this.mode = MODES.has(mode) ? mode : "json";
    this.databaseUrl = databaseUrl;
    this.shadowStatus = shadowStatus;
    this.userStore = userStore;
    this.sessionStore = sessionStore;
    this.refreshMs = Math.max(500, Number(refreshMs) || 1000);
    this.cacheMaxAgeMs = Math.max(3000, Number(cacheMaxAgeMs) || this.refreshMs * 5);
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
    this.timer = null;
    this.currentRefresh = null;
    this.cache = { ready: false, sourceHash: null, users: [], sessions: [] };
    this.metrics = {
      postgresReads: 0,
      jsonFallbacks: 0,
      consistencyFallbacks: 0,
      parityFallbacks: 0,
      refreshes: 0,
      refreshFailures: 0,
      lastRefreshAt: null,
      lastReadAt: null,
      lastFallbackReason: null,
      error: null,
    };
    if (typeof this.pool?.on === "function") {
      this.pool.on("error", (error) => {
        this.cache.ready = false;
        this.metrics.error = cleanError(error, this.databaseUrl);
      });
    }
  }

  status() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      cacheReady: this.cache.ready,
      refreshing: !!this.currentRefresh,
      ...this.metrics,
    };
  }

  start() {
    if (!this.enabled || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  async refresh() {
    if (!this.enabled) return { skipped: true, reason: "disabled" };
    if (this.currentRefresh) return this.currentRefresh;
    this.currentRefresh = this.#refresh()
      .catch((error) => {
        this.metrics.refreshFailures += 1;
        this.metrics.error = cleanError(error, this.databaseUrl);
        return { ok: false, error: this.metrics.error };
      })
      .finally(() => { this.currentRefresh = null; });
    return this.currentRefresh;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.currentRefresh) await this.currentRefresh;
    if (this.ownedPool && this.pool) await this.pool.end();
  }

  authenticate(emailInput, passwordInput) {
    const email = String(emailInput || "").trim().toLowerCase();
    const password = String(passwordInput || "");
    return this.#read(
      () => this.userStore.authenticate(email, password),
      () => {
        const user = this.cache.users.find((item) => item.email === email);
        if (!user || user.disabled || !password) return null;
        const actual = crypto.scryptSync(password, user.salt, 64);
        const expected = Buffer.from(user.passwordHash, "base64url");
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
        return sessionUser(user);
      },
    );
  }

  sessionUser(id) {
    const key = String(id || "");
    return this.#read(
      () => this.userStore.sessionUser(key),
      () => sessionUser(this.cache.users.find((user) => user.id === key)),
    );
  }

  listUsers() {
    return this.#read(
      () => this.userStore.list(),
      () => this.cache.users.map(publicUser),
    );
  }

  touchSession(id, userId) {
    const sessionId = String(id || "");
    const owner = String(userId || "");
    const active = this.#read(
      () => !!this.sessionStore.active(sessionId, owner),
      () => !!this.#activeSession(sessionId, owner),
    );
    if (active) this.sessionStore.touch(sessionId, owner);
    return active;
  }

  listSessions(userId, currentId = "") {
    const owner = String(userId || "");
    return this.#read(
      () => this.sessionStore.list(owner, currentId),
      () => this.cache.sessions
        .filter((session) => session.userId === owner && !session.revokedAt
          && new Date(session.expiresAt).getTime() > Date.now())
        .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt))
        .map((session) => publicSession(session, currentId)),
    );
  }

  #activeSession(id, userId) {
    const session = this.cache.sessions.find((item) => item.id === id && item.userId === userId);
    if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= Date.now()) return null;
    return session;
  }

  #gate() {
    if (!this.enabled) return "disabled";
    const shadow = this.shadowStatus();
    if (shadow.status !== "ready") return "shadow_not_ready";
    if (shadow.inFlight) return "shadow_syncing";
    if ((shadow.outbox?.pending || 0) > 0) return "outbox_pending";
    if (shadow.outbox?.error) return "outbox_error";
    if (!this.cache.ready) return "cache_not_ready";
    if (!this.metrics.lastRefreshAt
      || Date.now() - new Date(this.metrics.lastRefreshAt).getTime() > this.cacheMaxAgeMs) {
      return "cache_expired";
    }
    if (!shadow.sourceHash || this.cache.sourceHash !== shadow.sourceHash) return "cache_stale";
    return "";
  }

  #read(jsonRead, postgresRead) {
    this.metrics.lastReadAt = new Date().toISOString();
    const gate = this.#gate();
    if (gate) return this.#fallback(jsonRead, "consistency", gate);
    const postgresValue = postgresRead();
    if (this.mode === "canary") {
      const jsonValue = jsonRead();
      if (!same(postgresValue, jsonValue)) {
        return this.#fallback(() => jsonValue, "parity", "canary_mismatch");
      }
    }
    this.metrics.postgresReads += 1;
    this.metrics.lastFallbackReason = null;
    return postgresValue;
  }

  #fallback(read, kind, reason) {
    this.metrics.jsonFallbacks += 1;
    this.metrics[`${kind}Fallbacks`] += 1;
    this.metrics.lastFallbackReason = reason;
    return read();
  }

  async #refresh() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const [users, sessions, migration] = await Promise.all([
        client.query("SELECT payload FROM agentic_os_shadow.users ORDER BY id"),
        client.query("SELECT payload FROM agentic_os_shadow.sessions ORDER BY id"),
        client.query("SELECT source_hash FROM agentic_os_shadow.migration_runs ORDER BY id DESC LIMIT 1"),
      ]);
      await client.query("COMMIT");
      this.cache = {
        ready: true,
        sourceHash: migration.rows[0]?.source_hash || null,
        users: users.rows.map((row) => row.payload),
        sessions: sessions.rows.map((row) => row.payload),
      };
      this.metrics.refreshes += 1;
      this.metrics.lastRefreshAt = new Date().toISOString();
      this.metrics.error = null;
      return { ok: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
