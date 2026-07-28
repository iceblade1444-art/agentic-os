import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";

const EVENTS = new Set([
  "session_started", "session_ended", "turn_input", "turn_response",
  "turn_completed", "stt_warning", "session_error",
]);
const MAX_EVENTS = 2000;
const file = path.join(config.dataDir, "voice-metrics.json");

function read() {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(value.events) ? value.events : [];
  } catch {
    return [];
  }
}

function write(events) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, events: events.slice(-MAX_EVENTS) }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

function bounded(value, size) {
  return String(value || "").trim().slice(0, size);
}

export function recordVoiceMetric(user, input = {}) {
  const event = bounded(input.event, 40);
  if (!EVENTS.has(event)) throw Object.assign(new Error("Unsupported voice metric"), { status: 400 });
  const valueMs = Number(input.valueMs);
  const item = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    userId: bounded(user?.id, 100) || "unknown",
    event,
    transport: bounded(input.transport, 20),
    model: bounded(input.model, 100),
    language: bounded(input.language, 20),
    valueMs: Number.isFinite(valueMs) ? Math.max(0, Math.min(300000, Math.round(valueMs))) : null,
  };
  const events = read();
  events.push(item);
  write(events);
  return { ok: true };
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

export function voiceMetricSummary() {
  const since = Date.now() - 7 * 86400000;
  const events = read().filter((item) => Date.parse(item.at) >= since);
  const response = events.filter((item) => item.event === "turn_response" && Number.isFinite(item.valueMs)).map((item) => item.valueMs);
  const turns = events.filter((item) => item.event === "turn_completed").length;
  const errors = events.filter((item) => item.event === "session_error").length;
  const sttWarnings = events.filter((item) => item.event === "stt_warning").length;
  return {
    windowDays: 7,
    sessions: events.filter((item) => item.event === "session_started").length,
    turns,
    errors,
    sttWarnings,
    turnCompletionRate: turns + errors ? Number((turns / (turns + errors)).toFixed(3)) : null,
    responseLatencyMs: {
      samples: response.length,
      median: percentile(response, 0.5),
      p95: percentile(response, 0.95),
    },
    updatedAt: events.at(-1)?.at || null,
  };
}
