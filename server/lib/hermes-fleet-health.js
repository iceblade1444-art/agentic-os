import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";

const MAX_STATE_BYTES = 256 * 1024;
const DEFAULT_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function emptyState() {
  return {
    available: false,
    status: "unchecked",
    checkedAt: null,
    startedAt: null,
    stale: true,
    profiles: {},
  };
}

function cleanProfileHealth(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    ok: value.ok === true,
    checkedAt: value.checkedAt || null,
    latencyMs: Math.min(15 * 60 * 1000, Math.max(0, Number(value.latencyMs) || 0)),
    code: String(value.code || (value.ok ? "ok" : "failed")).slice(0, 40),
    error: String(value.error || "").slice(0, 240),
  };
}

export function readHermesFleetHealth(file = config.hermesFleetHealthFile, options = {}) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState();
    const profiles = {};
    for (const [name, value] of Object.entries(parsed.profiles || {})) {
      if (!PROFILE_NAME.test(name)) continue;
      const health = cleanProfileHealth(value);
      if (health) profiles[name] = health;
    }
    const checkedAt = parsed.checkedAt || null;
    const checkedMs = Date.parse(checkedAt || "");
    const maxAgeMs = Math.max(60_000, Number(options.maxAgeMs) || DEFAULT_MAX_AGE_MS);
    return {
      available: true,
      status: ["running", "healthy", "degraded"].includes(parsed.status) ? parsed.status : "unchecked",
      checkedAt,
      startedAt: parsed.startedAt || null,
      stale: !Number.isFinite(checkedMs) || Date.now() - checkedMs > maxAgeMs,
      profiles,
    };
  } catch {
    return emptyState();
  }
}

export function requestHermesFleetProbe(file = config.hermesFleetHealthRequestFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const requestedAt = new Date().toISOString();
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ requestedAt }) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* bind-mount permissions vary */ }
  return { ok: true, queued: true, requestedAt };
}

export function mergeHermesFleetHealth(payload, state = readHermesFleetHealth()) {
  const source = payload && typeof payload === "object" ? payload : {};
  const list = Array.isArray(source.profiles) ? source.profiles : [];
  const profiles = list.map((profile) => {
    if (!profile || typeof profile !== "object") return profile;
    return { ...profile, health: state.profiles[profile.name] || null };
  });
  const { profiles: _privateProfiles, ...fleetHealth } = state;
  return {
    ...source,
    profiles,
    fleetHealth: {
      ...fleetHealth,
      total: profiles.length,
      healthy: profiles.filter((profile) => profile?.health?.ok).length,
    },
  };
}
