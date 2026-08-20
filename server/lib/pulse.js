// Operational pulse for the dashboard: host metrics, the AgentOS runtime
// approval queue and event log, and a rolling metrics history that feeds the
// Operational Home sparklines. Everything is bounded and fails soft — the
// dashboard renders with whatever subset of probes answered.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";
import { runtimeInternalHeaders } from "./runtime-auth.js";

const SAMPLE_EVERY_MS = 30 * 60 * 1000;
const MAX_SAMPLES = 672; // 14 days at one sample per 30 minutes
const MAX_HISTORY_BYTES = 1024 * 1024;
const APPROVAL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const historyFile = () => path.join(path.resolve(config.dataDir), "metrics-history.json");
const bounded = (value, max = 200) => String(value ?? "").trim().slice(0, max);

function stamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function hostMetrics(dataDir = config.dataDir) {
  const metrics = { checkedAt: Date.now(), disk: null, memory: null, cpu: null };
  try {
    const stats = fs.statfsSync(path.resolve(dataDir));
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    if (total > 0) metrics.disk = { totalBytes: total, freeBytes: free, usedPct: Math.min(100, Math.max(0, Math.round((1 - free / total) * 100))) };
  } catch { /* statfs unsupported — dashboard shows the probe as unavailable */ }
  const totalMem = os.totalmem();
  if (totalMem > 0) metrics.memory = { totalBytes: totalMem, freeBytes: os.freemem(), usedPct: Math.min(100, Math.max(0, Math.round((1 - os.freemem() / totalMem) * 100))) };
  const cores = os.cpus().length || 1;
  metrics.cpu = { cores, loadPct: Math.min(100, Math.max(0, Math.round((os.loadavg()[0] / cores) * 100))) };
  return metrics;
}

async function runtimeJson(pathname, options = {}) {
  const response = await fetch(config.agentosRuntimeUrl + pathname, {
    method: options.method || "GET",
    headers: runtimeInternalHeaders({ Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) }),
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || 3500),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `AgentOS runtime HTTP ${response.status}`);
  return data;
}

export async function pendingApprovals() {
  const data = await runtimeJson("/api/approvals");
  const items = Array.isArray(data) ? data : Array.isArray(data?.approvals) ? data.approvals : [];
  return items
    .filter((item) => item && typeof item === "object" && item.status === "pending")
    .slice(0, 20)
    .map((item) => ({
      id: bounded(item.id, 128),
      action: bounded(item.action, 120),
      summary: bounded(item.summary || item.action, 300),
      project: bounded(item.project || item.slug, 120),
      requestedAt: stamp(item.created_at || item.requested_at || item.updated_at),
    }));
}

export async function decideApproval(id, decision) {
  const approvalId = bounded(id, 128);
  if (!APPROVAL_ID.test(approvalId)) throw Object.assign(new Error("Invalid approval id"), { status: 400 });
  if (decision !== "approve" && decision !== "deny") throw Object.assign(new Error("Decision must be approve or deny"), { status: 400 });
  return runtimeJson(`/api/approvals/${encodeURIComponent(approvalId)}/${decision}`, { method: "POST", body: {}, timeoutMs: 8000 });
}

export async function runtimeEvents(limit = 30) {
  const data = await runtimeJson("/api/events");
  const items = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : [];
  return items
    .slice(-Math.min(100, Math.max(1, limit)))
    .map((event) => ({
      at: stamp(event?.at || event?.time || event?.created_at),
      type: bounded(event?.type || "event", 60),
      actor: bounded(event?.actor || event?.agent || "AgentOS", 80),
      message: bounded(event?.message || event?.summary || event?.detail, 300),
      project: bounded(event?.project, 120),
    }))
    .filter((event) => event.message || event.type !== "event");
}

export function readHistory(file = historyFile()) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_HISTORY_BYTES) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((sample) => sample && typeof sample === "object" && Number.isFinite(Number(sample.t)))
      .slice(-MAX_SAMPLES);
  } catch {
    return [];
  }
}

// Appends one numeric snapshot at most every SAMPLE_EVERY_MS; older calls are
// no-ops so any number of dashboard loads costs one write per half hour.
export function recordSample(sample, { file = historyFile(), now = Date.now() } = {}) {
  const history = readHistory(file);
  const last = history[history.length - 1];
  if (last && now - Number(last.t) < SAMPLE_EVERY_MS) return history;
  const clean = { t: now };
  for (const [key, value] of Object.entries(sample || {})) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^[a-zA-Z][a-zA-Z0-9]{0,30}$/.test(key)) clean[key] = numeric;
  }
  history.push(clean);
  const trimmed = history.slice(-MAX_SAMPLES);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(trimmed), { mode: 0o600 });
    hardenRuntimeFile(file, 0o600);
  } catch { /* history is best-effort — never fail the dashboard for it */ }
  return trimmed;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DONE_STATUSES = new Set(["completed", "done", "success"]);

export function missionStats(missions, now = Date.now()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const start = today.getTime() - 13 * DAY_MS;
  const days = Array.from({ length: 14 }, (_, i) => ({ t: start + i * DAY_MS, done: 0 }));
  let doneThisWeek = 0, donePrevWeek = 0, active = 0;
  for (const mission of Array.isArray(missions) ? missions : []) {
    if (!mission || typeof mission !== "object") continue;
    const status = String(mission.status || "");
    if (status === "running" || status === "pending" || status.startsWith("waiting")) active += 1;
    if (!DONE_STATUSES.has(status)) continue;
    const finishedAt = stamp(mission.events?.[mission.events.length - 1]?.at) || stamp(mission.createdAt);
    if (!finishedAt) continue;
    const age = now - finishedAt;
    if (age <= 7 * DAY_MS) doneThisWeek += 1;
    else if (age <= 14 * DAY_MS) donePrevWeek += 1;
    const bucket = Math.floor((finishedAt - start) / DAY_MS);
    if (bucket >= 0 && bucket < 14) days[bucket].done += 1;
  }
  return { days, doneThisWeek, donePrevWeek, active };
}
