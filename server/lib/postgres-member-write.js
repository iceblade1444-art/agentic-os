import pg from "pg";

const { Pool } = pg;
const SCHEMA = "agentic_os_shadow";
const MODES = new Set(["json", "member-shadow", "member-primary"]);
const MIGRATION_LOCK = 1447145031;

const cleanError = (error, databaseUrl = "") => {
  let message = String(error?.message || error || "PostgreSQL write failed");
  if (databaseUrl) message = message.replaceAll(databaseUrl, "[database]");
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database]")
    .replace(/(password\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 200);
};

export class PostgresMemberWriteAdapter {
  constructor({
    mode = "json",
    databaseUrl = "",
    shadowStatus = () => ({ status: "disabled" }),
    fallbackStore,
    pool = null,
  } = {}) {
    this.mode = MODES.has(mode) ? mode : "json";
    this.primary = this.mode === "member-primary";
    this.enabled = this.mode !== "json" && !!databaseUrl;
    this.databaseUrl = databaseUrl;
    this.shadowStatus = shadowStatus;
    this.fallbackStore = fallbackStore;
    this.ownedPool = !pool && this.enabled;
    this.pool = pool || (this.enabled ? new Pool({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 1500,
      idleTimeoutMillis: 10000,
      statement_timeout: 4000,
      query_timeout: 5000,
    }) : null);
    this.userQueues = new Map();
    this.metrics = {
      jsonWrites: 0,
      postgresWrites: 0,
      fallbackWrites: 0,
      gateFallbacks: 0,
      queryFallbacks: 0,
      lastWriteAt: null,
      lastFallbackReason: null,
      lastErrorAt: null,
      error: null,
    };
    if (typeof this.pool?.on === "function") {
      this.pool.on("error", (error) => {
        this.metrics.error = cleanError(error, this.databaseUrl);
        this.metrics.lastErrorAt = new Date().toISOString();
      });
    }
  }

  status() {
    const shadow = this.shadowStatus();
    if (this.userQueues.size === 0 && shadow.status === "ready" && shadow.outbox
      && (shadow.outbox.pending || 0) === 0 && !shadow.outbox.error
      && shadow.lastSuccessAt && this.metrics.lastErrorAt
      && new Date(shadow.lastSuccessAt) > new Date(this.metrics.lastErrorAt)) {
      this.metrics.error = null;
      if (this.metrics.lastFallbackReason === "query_error") this.metrics.lastFallbackReason = null;
    }
    return {
      enabled: this.enabled,
      mode: this.mode,
      primary: this.primary,
      queuedUsers: this.userQueues.size,
      ...this.metrics,
    };
  }

  createTask(userId, input) {
    return this.#mutate(userId, () => this.fallbackStore.createTask(userId, input));
  }

  updateTask(userId, taskId, input) {
    return this.#mutate(userId, () => this.fallbackStore.updateTask(userId, taskId, input));
  }

  deleteTask(userId, taskId) {
    return this.#mutate(userId, () => this.fallbackStore.deleteTask(userId, taskId));
  }

  createNote(userId, input) {
    return this.#mutate(userId, () => this.fallbackStore.createNote(userId, input));
  }

  updateNote(userId, noteId, input) {
    return this.#mutate(userId, () => this.fallbackStore.updateNote(userId, noteId, input));
  }

  deleteNote(userId, noteId) {
    return this.#mutate(userId, () => this.fallbackStore.deleteNote(userId, noteId));
  }

  syncChat(userId, input) {
    return this.#mutate(userId, () => this.fallbackStore.syncChat(userId, input));
  }

  clearChat(userId) {
    return this.#mutate(userId, () => this.fallbackStore.clearChat(userId));
  }

  createInboxItem(userId, input) {
    return this.#mutate(userId, () => this.fallbackStore.createInboxItem(userId, input));
  }

  updateInboxItem(userId, itemId, input) {
    return this.#mutate(userId, () => this.fallbackStore.updateInboxItem(userId, itemId, input));
  }

  remove(userId) {
    return this.#mutate(userId, () => this.fallbackStore.remove(userId), { syncOnNoop: true });
  }

  async stop() {
    await Promise.allSettled([...this.userQueues.values()]);
    if (this.ownedPool && this.pool) await this.pool.end();
  }

  async #mutate(userId, mutation, { syncOnNoop = false } = {}) {
    const before = this.primary ? this.fallbackStore.read(userId) : null;
    const result = mutation();
    if ((result === null || result === false) && !syncOnNoop) return result;
    if (result !== null && result !== false) this.metrics.jsonWrites += 1;
    this.metrics.lastWriteAt = new Date().toISOString();
    if (!this.enabled) return result;

    const shadow = this.shadowStatus();
    if (shadow.status !== "ready") {
      this.#fallback("gate", "shadow_not_ready");
      if (this.primary) {
        this.fallbackStore.write(userId, before);
        throw this.#primaryError("PostgreSQL is not ready");
      }
      return result;
    }

    try {
      await this.#enqueue(userId);
      this.metrics.postgresWrites += 1;
      this.metrics.lastFallbackReason = null;
      this.metrics.error = null;
    } catch (error) {
      this.metrics.error = cleanError(error, this.databaseUrl);
      this.metrics.lastErrorAt = new Date().toISOString();
      this.#fallback("query", "query_error");
      if (this.primary) {
        this.fallbackStore.write(userId, before);
        throw this.#primaryError(this.metrics.error);
      }
    }
    return result;
  }

  #primaryError(message) {
    const error = new Error(`Could not commit workspace change: ${message}`);
    error.code = "postgres_commit_failed";
    error.status = 503;
    return error;
  }

  #fallback(kind, reason) {
    this.metrics.fallbackWrites += 1;
    this.metrics[`${kind}Fallbacks`] += 1;
    this.metrics.lastFallbackReason = reason;
  }

  #enqueue(userId) {
    const key = String(userId);
    const previous = this.userQueues.get(key) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.#syncUser(key));
    this.userQueues.set(key, current);
    current.finally(() => {
      if (this.userQueues.get(key) === current) this.userQueues.delete(key);
    }).catch(() => {});
    return current;
  }

  async #syncUser(userId) {
    const workspace = this.fallbackStore.read(userId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      await client.query(`DELETE FROM ${SCHEMA}.member_tasks WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM ${SCHEMA}.member_notes WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM ${SCHEMA}.member_chat_messages WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM ${SCHEMA}.member_inbox_items WHERE user_id = $1`, [userId]);
      for (const task of workspace.tasks) {
        await client.query(
          `INSERT INTO ${SCHEMA}.member_tasks
           (id,user_id,title,detail,status,priority,due_date,created_at,updated_at,payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [task.id, userId, task.title, task.detail || "", task.status, task.priority,
            task.dueDate || null, task.createdAt, task.updatedAt, { ...task, userId }],
        );
      }
      for (const note of workspace.notes) {
        await client.query(
          `INSERT INTO ${SCHEMA}.member_notes
           (id,user_id,title,content,created_at,updated_at,payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [note.id, userId, note.title, note.content || "", note.createdAt,
            note.updatedAt, { ...note, userId }],
        );
      }
      for (const message of workspace.chatMessages || []) {
        await client.query(
          `INSERT INTO ${SCHEMA}.member_chat_messages
           (id,user_id,role,source,created_at,updated_at,payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [message.id, userId, message.role, message.source, message.createdAt,
            message.updatedAt, { ...message, userId }],
        );
      }
      for (const item of workspace.inboxItems || []) {
        await client.query(
          `INSERT INTO ${SCHEMA}.member_inbox_items
           (id,user_id,status,type,priority,created_at,updated_at,payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [item.id, userId, item.status, item.type, item.priority, item.createdAt,
            item.updatedAt, { ...item, userId }],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
