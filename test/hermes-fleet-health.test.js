import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  mergeHermesFleetHealth, readHermesFleetHealth, requestHermesFleetProbe,
} from "../server/lib/hermes-fleet-health.js";

test("Hermes fleet health reads bounded state and merges it without exposing the full file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-fleet-"));
  const file = path.join(dir, "health.json");
  const checkedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({
    status: "healthy",
    checkedAt,
    profiles: {
      default: { ok: true, latencyMs: 1234, code: "ok", checkedAt },
      dev: { ok: false, latencyMs: 2000, code: "auth_required", error: "Renew authentication.", checkedAt },
      "../invalid": { ok: true },
    },
  }));
  const health = readHermesFleetHealth(file);
  assert.equal(health.available, true);
  assert.equal(health.stale, false);
  assert.deepEqual(Object.keys(health.profiles).sort(), ["default", "dev"]);

  const merged = mergeHermesFleetHealth({
    profiles: [{ name: "default", model: "gpt-5.5" }, { name: "dev", model: "gpt-5.4" }],
  }, health);
  assert.equal(merged.fleetHealth.healthy, 1);
  assert.equal(merged.profiles[0].health.ok, true);
  assert.equal(merged.profiles[1].health.code, "auth_required");
  assert.equal("profiles" in merged.fleetHealth, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Hermes fleet probe requests are atomic and contain no credentials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-fleet-request-"));
  const file = path.join(dir, "probe.request");
  const result = requestHermesFleetProbe(file);
  assert.equal(result.queued, true);
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.match(payload.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(JSON.stringify(payload).includes("token"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
