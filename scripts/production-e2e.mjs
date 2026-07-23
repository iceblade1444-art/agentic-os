#!/usr/bin/env node
import process from "node:process";

const DEFAULT_URL = "https://agent.milanapremium.uz";
const timeoutMs = Math.max(1000, Number(process.env.E2E_TIMEOUT_MS) || 10000);
const token = process.env.AGENTIC_OS_TOKEN || process.env.AUTH_TOKEN || "";

function baseUrls() {
  const values = [
    process.env.AGENTIC_OS_PUBLIC_URL || process.argv[2] || DEFAULT_URL,
    process.env.AGENTIC_OS_INTERNAL_URL || process.argv[3] || "",
  ].map((value) => String(value || "").replace(/\/$/, "")).filter(Boolean);
  return [...new Set(values)];
}

function controller() {
  const item = new AbortController();
  const timer = setTimeout(() => item.abort(), timeoutMs);
  return { signal: item.signal, cancel: () => clearTimeout(timer) };
}

async function request(base, path, { auth = false, json = true } = {}) {
  const url = `${base}${path}`;
  const abort = controller();
  try {
    const headers = auth && token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(url, { headers, signal: abort.signal });
    const body = json ? await response.json().catch(() => ({})) : await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return body;
  } finally {
    abort.cancel();
  }
}

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: Date.now() - started, detail };
  } catch (error) {
    return { name, ok: false, ms: Date.now() - started, error: error.message };
  }
}

async function checkBase(base) {
  const checks = [
    check("SPA shell", async () => {
      const text = await request(base, "/", { json: false });
      if (!text.includes("Agentic OS")) throw new Error("index shell did not render");
      return "index.html";
    }),
    check("Health API", async () => {
      const health = await request(base, "/api/health");
      if (!health.ok) throw new Error("health payload is not ok");
      return `providers=${Object.entries(health.providers || {}).filter(([, ready]) => ready).map(([key]) => key).join(",") || "none"}`;
    }),
  ];

  if (!token) {
    checks.push(check("Protected API", async () => "skipped: set AGENTIC_OS_TOKEN or AUTH_TOKEN"));
  } else {
    checks.push(
      check("Auth session", async () => {
        const me = await request(base, "/api/auth/me", { auth: true });
        if (!me.authed) throw new Error("bearer token was not accepted");
        return me.user?.role || "authenticated";
      }),
      check("Operations status", async () => {
        const state = await request(base, "/api/operations/status", { auth: true });
        if (!state.readiness?.framework) throw new Error("readiness audit missing");
        return `${state.status || "unknown"} FourC=${state.readiness.score ?? "n/a"}`;
      }),
      check("Kanban board", async () => {
        const board = await request(base, "/api/kanban/board", { auth: true });
        if (!Array.isArray(board.columns)) throw new Error("board columns missing");
        return `${board.columns.length} columns`;
      }),
      check("Obsidian library", async () => {
        const knowledge = await request(base, "/api/knowledge/status", { auth: true });
        return `${knowledge.notes || 0} notes, writable=${knowledge.writable === true}`;
      }),
      check("MILA integration", async () => {
        const mila = await request(base, "/api/integrations/mila/status", { auth: true });
        return mila.ok ? `ok voice=${mila.voiceConfigured === true}` : (mila.error || "unavailable");
      }),
      check("Hermes control", async () => {
        const hermes = await request(base, "/api/hermes/control/status", { auth: true });
        return hermes.ready ? "ready" : (hermes.error || "unavailable");
      }),
    );
  }

  const results = await Promise.all(checks);
  return { base, results };
}

const reports = await Promise.all(baseUrls().map(checkBase));
let failed = 0;
for (const report of reports) {
  console.log(`\n${report.base}`);
  for (const result of report.results) {
    if (!result.ok) failed += 1;
    const status = result.ok ? "OK" : "FAIL";
    console.log(`  ${status.padEnd(4)} ${result.name.padEnd(20)} ${String(result.ms).padStart(5)}ms  ${result.detail || result.error}`);
  }
}

if (failed) {
  console.error(`\nProduction E2E failed: ${failed} check(s) failed.`);
  process.exit(1);
}

console.log("\nProduction E2E passed.");
