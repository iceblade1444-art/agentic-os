import { migratePostgresShadow } from "./postgres-migration.js";

const iso = () => new Date().toISOString();
const boundedError = (error, databaseUrl = "") => {
  let message = String(error?.message || error || "Unknown PostgreSQL error");
  if (databaseUrl) message = message.replaceAll(databaseUrl, "[database]");
  message = message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database]")
    .replace(/(password\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
  return message.slice(0, 240);
};

export class PostgresShadowSync {
  constructor({
    enabled = false,
    dataDir,
    databaseUrl,
    intervalMs = 30000,
    debounceMs = 500,
    migrate = migratePostgresShadow,
    outbox = null,
  } = {}) {
    this.enabled = !!enabled && !!databaseUrl;
    this.dataDir = dataDir;
    this.databaseUrl = databaseUrl;
    this.intervalMs = Math.max(5000, Number(intervalMs) || 30000);
    this.debounceMs = Math.max(100, Number(debounceMs) || 500);
    this.migrate = migrate;
    this.outbox = outbox;
    this.timer = null;
    this.debounceTimer = null;
    this.currentRun = null;
    this.resyncRequested = false;
    this.state = {
      mode: "shadow",
      status: this.enabled ? "pending" : "disabled",
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastDurationMs: null,
      consecutiveFailures: 0,
      sourceHash: null,
      counts: null,
      error: null,
    };
  }

  status() {
    return {
      enabled: this.enabled,
      mode: this.state.mode,
      status: this.state.status,
      intervalSeconds: Math.round(this.intervalMs / 1000),
      inFlight: !!this.currentRun,
      lastAttemptAt: this.state.lastAttemptAt,
      lastSuccessAt: this.state.lastSuccessAt,
      lastDurationMs: this.state.lastDurationMs,
      consecutiveFailures: this.state.consecutiveFailures,
      sourceHash: this.state.sourceHash,
      counts: this.state.counts ? { ...this.state.counts } : null,
      outbox: this.outbox?.status() || { pending: 0, oldestAt: null, bytes: 0, error: null },
      error: this.state.error,
    };
  }

  start() {
    if (!this.enabled || this.timer) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), this.intervalMs);
    this.timer.unref?.();
  }

  request() {
    if (!this.enabled) return false;
    if (this.currentRun) {
      this.resyncRequested = true;
      return true;
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.run();
    }, this.debounceMs);
    this.debounceTimer.unref?.();
    return true;
  }

  async run() {
    if (!this.enabled) return { skipped: true, reason: "disabled" };
    if (this.currentRun) return { skipped: true, reason: "in_flight" };

    const started = Date.now();
    this.state.status = "syncing";
    this.state.lastAttemptAt = iso();
    this.state.error = null;
    const outboxBatch = this.outbox?.snapshot() || [];
    let succeeded = false;
    this.currentRun = (async () => {
      try {
        const result = await this.migrate({
          dataDir: this.dataDir,
          databaseUrl: this.databaseUrl,
        });
        this.state.status = "ready";
        this.state.lastSuccessAt = iso();
        this.state.lastDurationMs = Date.now() - started;
        this.state.consecutiveFailures = 0;
        this.state.sourceHash = result.sourceHash || null;
        this.state.counts = result.sourceCounts || null;
        this.outbox?.acknowledge(outboxBatch.map((event) => event.id));
        succeeded = true;
        return result;
      } catch (error) {
        this.state.status = "error";
        this.state.lastDurationMs = Date.now() - started;
        this.state.consecutiveFailures += 1;
        this.state.error = boundedError(error, this.databaseUrl);
        console.error(`[postgres-shadow] sync failed: ${this.state.error}`);
        return { ok: false, error: this.state.error };
      } finally {
        this.currentRun = null;
        const outboxStatus = this.outbox?.status();
        const shouldResync = succeeded
          && !outboxStatus?.error
          && (this.resyncRequested || (outboxStatus?.pending || 0) > 0);
        this.resyncRequested = false;
        if (shouldResync) {
          this.request();
        }
      }
    })();
    return this.currentRun;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.currentRun) await this.currentRun;
  }
}
