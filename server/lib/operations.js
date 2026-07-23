import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";

const MAX_STATE_BYTES = 1024 * 1024;

function emptyState() {
  return {
    available: false,
    status: "unknown",
    checkedAt: null,
    checks: [],
    incidents: [],
    activeIncidents: 0,
    backup: { status: "unknown", lastSuccessAt: null, count: 0 },
    restoreDrill: { status: "unknown", lastSuccessAt: null },
    schedule: { monitorEveryMinutes: 5, backupDailyAt: "03:15", timezone: "server local time" },
  };
}

export function readOperationsState(file = config.operationsStateFile) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState();
    return {
      ...emptyState(),
      available: true,
      version: Number(parsed.version) || 1,
      status: String(parsed.status || "unknown").slice(0, 40),
      updatedAt: parsed.updatedAt || null,
      checkedAt: parsed.checkedAt || null,
      checks: Array.isArray(parsed.checks) ? parsed.checks.slice(0, 50) : [],
      incidents: Array.isArray(parsed.incidents) ? parsed.incidents.slice(-50).reverse() : [],
      activeIncidents: Math.max(0, Number(parsed.activeIncidents) || 0),
      backup: parsed.backup && typeof parsed.backup === "object" ? parsed.backup : emptyState().backup,
      restoreDrill: parsed.restoreDrill && typeof parsed.restoreDrill === "object" ? parsed.restoreDrill : emptyState().restoreDrill,
      schedule: parsed.schedule && typeof parsed.schedule === "object" ? parsed.schedule : emptyState().schedule,
    };
  } catch {
    return emptyState();
  }
}

export function requestOperationsBackup(file = config.operationsBackupRequestFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ requestedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* volume permissions vary */ }
  return { ok: true, queued: true, requestedAt: new Date().toISOString() };
}

export function requestOperationsRestoreDrill(file = config.operationsRestoreRequestFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ requestedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* volume permissions vary */ }
  return { ok: true, queued: true, requestedAt: new Date().toISOString() };
}
