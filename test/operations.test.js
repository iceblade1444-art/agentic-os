import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { readOperationsState, requestOperationsBackup, requestOperationsRestoreDrill } from "../server/lib/operations.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

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
    restoreDrill: { status: "success", filesChecked: 4 },
    schedule: { monitorEveryMinutes: 5 },
    accidentalSecret: "must-not-leak",
  }));
  const state = readOperationsState(file);
  assert.equal(state.available, true);
  assert.equal(state.status, "healthy");
  assert.equal(state.incidents[0].id, "new");
  assert.equal(state.restoreDrill.filesChecked, 4);
  assert.equal(state.accidentalSecret, undefined);
});

test("missing operations state is explicit and operation requests contain no commands", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-ops-request-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(readOperationsState(path.join(dir, "missing.json")).available, false);
  const requestFile = path.join(dir, "backup.request");
  const result = requestOperationsBackup(requestFile);
  assert.equal(result.queued, true);
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  assert.match(request.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(request), ["requestedAt"]);

  const restoreRequestFile = path.join(dir, "restore.request");
  const restore = requestOperationsRestoreDrill(restoreRequestFile);
  assert.equal(restore.queued, true);
  const restoreRequest = JSON.parse(fs.readFileSync(restoreRequestFile, "utf8"));
  assert.match(restoreRequest.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(restoreRequest), ["requestedAt"]);
});

test("operations UI and host installer use real API, timers and path activation", () => {
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../assets/js/pages/misc.js", import.meta.url), "utf8");
  const dashboard = fs.readFileSync(new URL("../assets/js/pages/dashboard.js", import.meta.url), "utf8");
  const installer = fs.readFileSync(new URL("../scripts/install-agentic-os-operations.sh", import.meta.url), "utf8");
  const operator = fs.readFileSync(new URL("../scripts/agentic-os-operations.py", import.meta.url), "utf8");
  const productionE2e = fs.readFileSync(new URL("../scripts/production-e2e.mjs", import.meta.url), "utf8");
  const memberE2e = fs.readFileSync(new URL("../scripts/production-member-e2e.mjs", import.meta.url), "utf8");
  const smtpVerify = fs.readFileSync(new URL("../scripts/smtp-verify.mjs", import.meta.url), "utf8");
  const smtpSetup = fs.readFileSync(new URL("../scripts/configure-corporate-smtp.sh", import.meta.url), "utf8");
  const deploy = fs.readFileSync(new URL("../deploy.sh", import.meta.url), "utf8");
  const store = fs.readFileSync(new URL("../server/store.js", import.meta.url), "utf8");
  const users = fs.readFileSync(new URL("../server/lib/users.js", import.meta.url), "utf8");
  const onboarding = fs.readFileSync(new URL("../server/lib/onboarding.js", import.meta.url), "utf8");
  const runtimeFiles = fs.readFileSync(new URL("../server/lib/runtime-files.js", import.meta.url), "utf8");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(api, /\/api\/operations\/status/);
  assert.match(api, /\/api\/operations\/backup/);
  assert.match(api, /\/api\/operations\/restore-drill/);
  assert.doesNotMatch(page, /14,208|Rate limit approaching|search_web\(query/);
  assert.match(page, /operations\.hostChecks/);
  assert.match(page, /operations\.restoreDrill/);
  assert.match(page, /operations\.readiness/);
  assert.match(dashboard, /api\.operations\.status/);
  assert.match(dashboard, /api\.kanban\.board/);
  assert.match(dashboard, /api\.routines\.list/);
  assert.match(dashboard, /api\.knowledge\.usage/);
  assert.match(dashboard, /bounded\(api\.hermes\.status/);
  assert.match(dashboard, /timeoutValue/);
  assert.match(dashboard, /Operational Home/);
  assert.doesNotMatch(dashboard, /randomSeries|Tokens Used|Success Rate.*82|All systems operational/);
  assert.match(installer, /OnUnitActiveSec=5min/);
  assert.match(installer, /OnCalendar=\*-\*-\* 03:15:00/);
  assert.match(installer, /OnCalendar=\*-\*-\* 04:00:00/);
  assert.match(installer, /agentic-os-deep-check\.timer/);
  assert.match(installer, /PathExists=.*backup\.request/);
  assert.match(installer, /PathExists=.*restore\.request/);
  assert.match(installer, /agentic-os-restore-drill\.service/);
  assert.match(operator, /OPS_BACKUP_RETENTION_DAYS/);
  assert.match(operator, /OPS_TELEGRAM_BOT_TOKEN/);
  assert.match(operator, /restore_drill/);
  assert.match(operator, /assert_safe_tar_member/);
  assert.match(operator, /hermes_control_backup/);
  assert.match(operator, /hermes-control\.tgz/);
  assert.match(operator, /_sqlite_online_backup/);
  assert.doesNotMatch(operator, /google_token\.json|google_client_secret\.json/);
  assert.match(operator, /load_project_env/);
  assert.match(operator, /key in os\.environ/);
  assert.match(operator, /MILA voice backend/);
  assert.match(operator, /LiveKit signaling/);
  assert.match(operator, /Obsidian vault/);
  assert.equal(pkg.scripts["prod:e2e"], "node scripts/production-e2e.mjs");
  assert.equal(pkg.scripts["prod:member-e2e"], "node scripts/production-member-e2e.mjs");
  assert.equal(pkg.scripts["smtp:verify"], "node scripts/smtp-verify.mjs");
  assert.match(productionE2e, /AGENTIC_OS_PUBLIC_URL/);
  assert.match(productionE2e, /\/api\/operations\/status/);
  assert.match(productionE2e, /\/api\/kanban\/board/);
  assert.match(productionE2e, /\/api\/knowledge\/status/);
  assert.match(productionE2e, /\/api\/integrations\/mila\/livekit-token/);
  assert.match(productionE2e, /method:\s*"POST"/);
  assert.match(productionE2e, /\/api\/claude-code\/status\?probe=\$\{internal\}/);
  assert.match(productionE2e, /timeout: internal \? 60000/);
  assert.match(memberE2e, /\/api\/auth\/mobile\/register/);
  assert.match(memberE2e, /\/api\/auth\/login/);
  assert.match(memberE2e, /\/api\/member\/tasks/);
  assert.match(memberE2e, /\/api\/auth\/account\/export/);
  assert.match(memberE2e, /method:\s*"DELETE"/);
  assert.match(smtpVerify, /transport\.verify\(\)/);
  assert.match(smtpVerify, /SMTP_TEST_TO/);
  assert.doesNotMatch(smtpVerify, /console\.log\(.*password/);
  assert.match(smtpSetup, /read -r -s -p "Mailbox password \(hidden\): "/);
  assert.match(smtpSetup, /SMTP_HOST=mail\.milanapremium\.uz/);
  assert.match(smtpSetup, /Enter a valid recipient email/);
  assert.match(smtpSetup, /npm run smtp:verify/);
  assert.match(smtpSetup, /EMAIL_VERIFICATION_REQUIRED=true/);
  assert.match(smtpSetup, /trap restore ERR/);
  assert.match(deploy, /candidate staging health passed/);
  assert.match(deploy, /mandatory post-deploy smoke passed/);
  assert.match(deploy, /docker run --rm agentic-os:latest npm test/);
  assert.match(deploy, /docker compose exec -T -e AGENTIC_OS_INTERNAL_URL/);
  assert.match(deploy, /SPEECH_PROJECT=.*docker inspect/);
  assert.match(deploy, /EXTERNAL_SPEECH=true/);
  assert.match(deploy, /docker compose up -d --no-build --no-deps postgres agentos-runtime agentic-os/);
  assert.match(deploy, /chown -R \$\{HOST_UID\}:\$\{HOST_GID\} \/app\/data/);
  assert.match(deploy, /find \/app\/data -type f -exec chmod 600/);
  assert.match(store, /hardenRuntimeFile\(file, 0o600\)/);
  assert.match(users, /hardenRuntimeFile\(this\.filePath, 0o600\)/);
  assert.match(onboarding, /hardenRuntimeFile\(this\.filePath, 0o600\)/);
  assert.match(runtimeFiles, /fs\.chownSync\(file, config\.runtimeFiles\.uid, config\.runtimeFiles\.gid\)/);
});

const hasPython = process.platform !== "win32"
  && spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

test("host backup can be restore-drilled without touching source data", { skip: !hasPython }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-ops-drill-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.mkdirSync(path.join(dir, "vault"), { recursive: true });
  fs.mkdirSync(path.join(dir, "agentos-runtime", "memory"), { recursive: true });
  fs.writeFileSync(path.join(dir, "data", "db.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "vault", "Welcome.md"), "# Welcome\n");
  fs.writeFileSync(path.join(dir, "agentos-runtime", "memory", "index.json"), "{}\n");
  const hermes = path.join(dir, "hermes");
  fs.mkdirSync(path.join(hermes, "cron", "output", "routine"), { recursive: true });
  fs.mkdirSync(path.join(hermes, "memories"), { recursive: true });
  fs.writeFileSync(path.join(hermes, "SOUL.md"), "# Hermes\n");
  fs.writeFileSync(path.join(hermes, "memories", "MEMORY.md"), "# Memory\n");
  fs.writeFileSync(path.join(hermes, "cron", "jobs.json"), "[]\n");
  fs.writeFileSync(path.join(hermes, "cron", "output", "routine", "latest.md"), "# Verified\n");

  const stateDir = path.join(dir, "state");
  const backupDir = path.join(dir, "backups");
  const env = { ...process.env, OPS_STATE_DIR: stateDir, OPS_BACKUP_DIR: backupDir, OPS_HERMES_HOME: hermes };
  const backup = spawnSync("python3", ["scripts/agentic-os-operations.py", "backup", "--root", dir], { cwd: repoRoot, env, encoding: "utf8" });
  assert.equal(backup.status, 0, backup.stderr || backup.stdout);
  const drill = spawnSync("python3", ["scripts/agentic-os-operations.py", "restore-drill", "--root", dir], { cwd: repoRoot, env, encoding: "utf8" });
  assert.equal(drill.status, 0, drill.stderr || drill.stdout);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "operations.json"), "utf8"));
  assert.equal(state.backup.status, "success");
  assert.equal(state.restoreDrill.status, "success");
  assert.ok(state.restoreDrill.filesChecked >= 3);
  assert.ok(state.restoreDrill.archives.includes("hermes-control.tgz"));
  assert.equal(fs.existsSync(path.join(dir, "data", "db.json")), true);
});

test("a backup still completes where the Docker CLI is absent", { skip: !hasPython }, (t) => {
  // The suite also runs inside the application image, which has no docker
  // binary, and the PostgreSQL dump shells out to it. Losing the whole archive
  // over one optional probe would be far worse than skipping that dump.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-ops-nodocker-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "data", "db.json"), "{}\n");

  const stateDir = path.join(dir, "state");
  const emptyPath = path.join(dir, "no-tools");
  fs.mkdirSync(emptyPath, { recursive: true });
  // Emptying PATH is what hides docker, so the interpreter has to be launched by
  // absolute path — otherwise the child cannot start and proves nothing.
  const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
  assert.ok(python && path.isAbsolute(python), "python3 must be resolvable before PATH is emptied");
  const env = {
    ...process.env,
    OPS_STATE_DIR: stateDir,
    OPS_BACKUP_DIR: path.join(dir, "backups"),
    OPS_HERMES_HOME: path.join(dir, "hermes"),
    PATH: emptyPath,
  };
  const backup = spawnSync(python, ["scripts/agentic-os-operations.py", "backup", "--root", dir], {
    cwd: repoRoot, env, encoding: "utf8",
  });
  assert.equal(backup.status, 0, backup.stderr || backup.stdout);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "operations.json"), "utf8"));
  assert.equal(state.backup.status, "success", "a missing binary must not fail the backup");
});
