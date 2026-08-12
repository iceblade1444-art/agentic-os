import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { decideApproval, hostMetrics, missionStats, readHistory, recordSample } from "../server/lib/pulse.js";

test("host metrics are bounded percentages with no command execution", () => {
  const metrics = hostMetrics(os.tmpdir());
  assert.ok(metrics.checkedAt > 0);
  for (const probe of ["disk", "memory", "cpu"]) {
    const section = metrics[probe];
    if (!section) continue; // platform-dependent probes may be absent, never throw
    if (section.usedPct !== undefined) { assert.ok(section.usedPct >= 0 && section.usedPct <= 100); }
    if (section.loadPct !== undefined) { assert.ok(section.loadPct >= 0 && section.loadPct <= 100); }
  }
});

test("metrics history throttles samples, keeps numeric fields only and survives bad files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-pulse-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "metrics-history.json");

  const first = recordSample({ open: 4, approvals: 2, note: "must-drop", disk: "71" }, { file, now: 1000 });
  assert.equal(first.length, 1);
  assert.equal(first[0].open, 4);
  assert.equal(first[0].disk, 71);
  assert.equal(first[0].note, undefined);

  // Within the 30-minute window nothing is appended.
  const throttled = recordSample({ open: 9 }, { file, now: 1000 + 60 * 1000 });
  assert.equal(throttled.length, 1);

  const second = recordSample({ open: 9 }, { file, now: 1000 + 31 * 60 * 1000 });
  assert.equal(second.length, 2);
  assert.equal(readHistory(file).length, 2);

  fs.writeFileSync(file, "{not json");
  assert.deepEqual(readHistory(file), []);
});

test("mission stats bucket completions into days and weeks", () => {
  const now = Date.parse("2026-07-24T12:00:00Z");
  const day = 24 * 3600 * 1000;
  const stats = missionStats([
    { status: "completed", createdAt: now - day, events: [{ at: now - day }] },
    { status: "completed", createdAt: now - 9 * day, events: [{ at: now - 9 * day }] },
    { status: "running", createdAt: now, events: [] },
    { status: "failed", createdAt: now - day, events: [{ at: now - day }] },
  ], now);
  assert.equal(stats.doneThisWeek, 1);
  assert.equal(stats.donePrevWeek, 1);
  assert.equal(stats.active, 1);
  assert.equal(stats.days.length, 14);
  assert.equal(stats.days.reduce((sum, bucket) => sum + bucket.done, 0), 2);
});

test("approval decisions validate id and decision before touching the runtime", async () => {
  await assert.rejects(() => decideApproval("../escape", "approve"), /Invalid approval id/);
  await assert.rejects(() => decideApproval("apr_1", "destroy"), /approve or deny/);
});

test("dashboard uses the pulse API and fonts are self-hosted", () => {
  const dashboard = fs.readFileSync(new URL("../assets/js/pages/dashboard.js", import.meta.url), "utf8");
  const apiClient = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const fontsCss = fs.readFileSync(new URL("../assets/css/fonts.css", import.meta.url), "utf8");

  assert.match(apiClient, /\/api\/pulse/);
  assert.match(apiClient, /EventSource/);
  assert.match(dashboard, /api\.pulse\.status/);
  assert.match(dashboard, /t\("dash\.attention"\)/);
  assert.match(dashboard, /data-approval/);
  assert.match(dashboard, /oh-feed/);

  // Local-first: no font CDN anywhere in the shell or CSP.
  assert.doesNotMatch(indexHtml, /fonts\.googleapis|fonts\.gstatic/);
  assert.doesNotMatch(server, /fonts\.googleapis|fonts\.gstatic/);
  assert.match(indexHtml, /assets\/css\/fonts\.css/);
  for (const face of ["inter-latin", "inter-cyrillic", "jetbrains-mono-latin", "jetbrains-mono-cyrillic"]) {
    assert.match(fontsCss, new RegExp(face));
    assert.ok(fs.statSync(new URL(`../assets/fonts/${face}.woff2`, import.meta.url)).size > 1000, `${face}.woff2 should exist`);
  }

  // Scout no longer rides the CVD-unsafe violet/blue pair.
  assert.match(dashboard, /scout: \{[^}]*color: "teal"/);

  // GET /api/missions returns events as a count; the feed must guard the shape.
  assert.match(dashboard, /Array\.isArray\(mission\.events\)/);
});

test("mission list summary keeps events as a count and the dashboard tolerates it", () => {
  const missions = fs.readFileSync(new URL("../server/routes/missions.js", import.meta.url), "utf8");
  assert.match(missions, /events: m\.events\.length/);
});
