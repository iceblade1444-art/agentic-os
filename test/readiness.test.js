import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFourCReadiness } from "../server/lib/readiness.js";

function healthySnapshot() {
  return {
    onboardingState: {
      needsOnboarding: false,
      workspace: { goals: ["Ship the product"], completedAt: "2026-07-23T00:00:00Z" },
      profile: { completedAt: "2026-07-23T00:00:00Z" },
    },
    vault: { ready: true, writable: true, notes: 2 },
    hermes: { ready: true },
    claude: { ready: true, version: "2.1.214", auth: { loggedIn: true } },
    mila: { ok: true, voiceConfigured: true, liveModel: "gemini-live" },
    profiles: { profiles: ["default", "scout", "scribe", "reach", "dev"] },
    board: { columns: [{ name: "done", tasks: [{ id: "1" }] }, { name: "scheduled", tasks: [{ id: "2" }] }] },
    operations: {
      available: true,
      status: "healthy",
      activeIncidents: 0,
      backup: { status: "success", lastSuccessAt: "2026-07-23T03:15:00Z" },
      restoreDrill: { status: "success", lastSuccessAt: "2026-07-23T03:30:00Z" },
      schedule: { monitorEveryMinutes: 5 },
    },
    connectedIntegrations: ["mila"],
    liveMcp: ["mcp_obsidian"],
  };
}

test("Four C readiness reports a fully operational system", () => {
  const result = buildFourCReadiness(healthySnapshot());
  assert.equal(result.score, 100);
  assert.equal(result.status, "ready");
  assert.equal(result.sections.length, 4);
  assert.deepEqual(result.sections.map((item) => item.id), ["context", "connections", "capabilities", "cadence"]);
  assert.deepEqual(result.recommendations, []);
});

test("Four C readiness exposes concrete gaps without leaking configuration", () => {
  const snapshot = healthySnapshot();
  snapshot.board.columns.find((column) => column.name === "scheduled").tasks = [];
  snapshot.mila = { ok: false, error: "MILA is offline" };
  const result = buildFourCReadiness(snapshot);
  assert.equal(result.score, 83);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.recommendations.map((item) => item.title), ["Open MILA integration", "Open MILA Live", "Plan recurring work"]);
  assert.equal(JSON.stringify(result).includes("adminToken"), false);
});

test("Hermes routines satisfy the recurring cadence check", () => {
  const snapshot = healthySnapshot();
  snapshot.board.columns.find((column) => column.name === "scheduled").tasks = [];
  snapshot.cronJobs = [{ id: "daily-brief", enabled: true, schedule: "0 9 * * *" }];
  const result = buildFourCReadiness(snapshot);
  assert.equal(result.sections.find((item) => item.id === "cadence").score, 100);
  assert.equal(result.recommendations.some((item) => item.title === "Plan recurring work"), false);
});
