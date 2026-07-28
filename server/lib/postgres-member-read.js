import pg from "pg";

const { Pool } = pg;
const MODES = new Set(["json", "member-canary", "member"]);

const cleanError = (error, databaseUrl = "") => {
  let message = String(error?.message || error || "PostgreSQL read failed");
  if (databaseUrl) message = message.replaceAll(databaseUrl, "[database]");
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database]").slice(0, 200);
};

const taskFromPayload = (payload = {}) => ({
  id: payload.id,
  title: payload.title,
  detail: payload.detail || "",
  status: payload.status,
  priority: payload.priority,
  dueDate: payload.dueDate || "",
  createdAt: payload.createdAt,
  updatedAt: payload.updatedAt,
});

const noteFromPayload = (payload = {}) => ({
  id: payload.id,
  title: payload.title,
  content: payload.content || "",
  createdAt: payload.createdAt,
  updatedAt: payload.updatedAt,
});

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export class PostgresMemberReadAdapter {
  constructor({
    mode = "json",
    databaseUrl = "",
    shadowStatus = () => ({ status: "disabled", inFlight: false, outbox: { pending: 0 } }),
    fallbackStore,
    pool = null,
  } = {}) {
    this.mode = MODES.has(mode) ? mode : "json";
    this.enabled = this.mode !== "json" && !!databaseUrl;
    this.databaseUrl = databaseUrl;
    this.shadowStatus = shadowStatus;
    this.fallbackStore = fallbackStore;
    this.ownedPool = !pool && this.enabled;
    this.pool = pool || (this.enabled ? new Pool({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      statement_timeout: 3000,
      query_timeout: 4000,
    }) : null);
    this.metrics = {
      postgresReads: 0,
      jsonFallbacks: 0,
      consistencyFallbacks: 0,
      parityFallbacks: 0,
      queryFallbacks: 0,
      lastReadAt: null,
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
      ...this.metrics,
    };
  }

  async listTasks(userId) {
    return this.#read(
      () => this.fallbackStore.listTasks(userId),
      () => this.#queryTasks(userId),
    );
  }

  async listNotes(userId) {
    return this.#read(
      () => this.fallbackStore.listNotes(userId),
      () => this.#queryNotes(userId),
    );
  }

  async dashboard(userId) {
    const jsonDashboard = this.fallbackStore.dashboard(userId);
    return this.#read(() => jsonDashboard, async () => {
      const [tasks, notes] = await Promise.all([this.#queryTasks(userId), this.#queryNotes(userId)]);
      const today = new Date().toISOString().slice(0, 10);
      return {
        counts: {
          open: tasks.filter((task) => task.status !== "done").length,
          doing: tasks.filter((task) => task.status === "doing").length,
          due: tasks.filter((task) => task.status !== "done" && task.dueDate && task.dueDate <= today).length,
          notes: notes.length,
        },
        tasks: tasks.filter((task) => task.status !== "done").slice(0, 6),
        notes: notes.slice(0, 5),
        updatedAt: jsonDashboard.updatedAt,
      };
    });
  }

  async stop() {
    if (this.ownedPool && this.pool) await this.pool.end();
  }

  #gate() {
    if (!this.enabled) return "disabled";
    const shadow = this.shadowStatus();
    if (shadow.status !== "ready") return "shadow_not_ready";
    if (shadow.inFlight) return "shadow_syncing";
    if ((shadow.outbox?.pending || 0) > 0) return "outbox_pending";
    if (shadow.outbox?.error) return "outbox_error";
    return "";
  }

  async #read(fallback, query) {
    this.metrics.lastReadAt = new Date().toISOString();
    const gate = this.#gate();
    if (gate) return this.#fallback(fallback, "consistency", gate);
    try {
      const postgresValue = await query();
      if (this.mode === "member-canary") {
        const jsonValue = fallback();
        if (!same(postgresValue, jsonValue)) return this.#fallback(() => jsonValue, "parity", "canary_mismatch");
      }
      this.metrics.postgresReads += 1;
      this.metrics.lastFallbackReason = null;
      this.metrics.error = null;
      return postgresValue;
    } catch (error) {
      this.metrics.error = cleanError(error, this.databaseUrl);
      return this.#fallback(fallback, "query", "query_error");
    }
  }

  #fallback(fallback, kind, reason) {
    this.metrics.jsonFallbacks += 1;
    this.metrics[`${kind}Fallbacks`] += 1;
    this.metrics.lastFallbackReason = reason;
    return fallback();
  }

  async #queryTasks(userId) {
    const result = await this.pool.query(
      `SELECT payload FROM agentic_os_shadow.member_tasks
       WHERE user_id = $1
       ORDER BY
         CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END,
         due_date ASC NULLS LAST,
         updated_at DESC`,
      [String(userId)],
    );
    return result.rows.map((row) => taskFromPayload(row.payload));
  }

  async #queryNotes(userId) {
    const result = await this.pool.query(
      `SELECT payload FROM agentic_os_shadow.member_notes
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [String(userId)],
    );
    return result.rows.map((row) => noteFromPayload(row.payload));
  }
}
