import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readOperationsState, requestOperationsBackup } from "../server/lib/operations.js";

test("operations state is bounded and does not expose unknown host fields", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-ops-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "operations.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    status: "healthy",
    checkedAt: "2026-07-18T10:00:00Z",
    checks: [{ id: "api", status: "healthy" }],
    incidents: [{ id: "old" }, { id: "new" }],
    activeIncidents: 0,
    backup: { status: "success", count: 2 },
    schedule: { monitorEveryMinutes: 5 },
    accidentalSecret: "must-not-leak",
  }));
  const state = readOperationsState(file);
  assert.equal(state.available, true);
  assert.equal(state.status, "healthy");
  assert.equal(state.incidents[0].id, "new");
  assert.equal(state.accidentalSecret, undefined);
});

test("missing operations state is explicit and backup requests contain no commands", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-ops-request-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(readOperationsState(path.join(dir, "missing.json")).available, false);
  const requestFile = path.join(dir, "backup.request");
  const result = requestOperationsBackup(requestFile);
  assert.equal(result.queued, true);
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  assert.match(request.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(request), ["requestedAt"]);
});

test("operations UI and host installer use real API, timers and path activation", () => {
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../assets/js/pages/misc.js", import.meta.url), "utf8");
  const installer = fs.readFileSync(new URL("../scripts/install-agentic-os-operations.sh", import.meta.url), "utf8");
  const operator = fs.readFileSync(new URL("../scripts/agentic-os-operations.py", import.meta.url), "utf8");
  assert.match(api, /\/api\/operations\/status/);
  assert.match(api, /\/api\/operations\/backup/);
  assert.doesNotMatch(page, /14,208|Rate limit approaching|search_web\(query/);
  assert.match(page, /Host checks/);
  assert.match(installer, /OnUnitActiveSec=5min/);
  assert.match(installer, /OnCalendar=\*-\*-\* 03:15:00/);
  assert.match(installer, /PathExists=.*backup\.request/);
  assert.match(operator, /OPS_BACKUP_RETENTION_DAYS/);
  assert.match(operator, /OPS_TELEGRAM_BOT_TOKEN/);
  assert.match(operator, /load_project_env/);
  assert.match(operator, /key in os\.environ/);
});
