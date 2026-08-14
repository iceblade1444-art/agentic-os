// Runs the suite, then proves it left the real data directory untouched.
//
// The deploy gate runs tests on the production server against the real data
// directory, and node --test puts every file in its own process — so no
// in-suite check can see the others' writes reliably. This wrapper can: it
// snapshots data/ before the suite, runs it, snapshots again, and fails the
// build naming every file a test dirtied.
//
// It exists because of a real leak: a privacy test forgot to inject the member
// workspace store and wrote "Развод — документы к юристу" — a fixture built to
// look unmistakably private — into the owner's REAL notes on every deploy.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));

function snapshot() {
  const entries = new Map();
  const walk = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of names) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      try {
        const stat = fs.statSync(full);
        entries.set(path.relative(dataDir, full), `${stat.size}:${Math.round(stat.mtimeMs)}`);
      } catch { /* removed mid-walk */ }
    }
  };
  walk(dataDir);
  return entries;
}

// Files a test run may legitimately change: module side effects of merely
// importing the server. Every entry needs a reason.
const ALLOWED = new Set([
  "db.json", // store.js backfills newly seeded collections on load
]);

const before = snapshot();
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2)], {
  cwd: root, stdio: "inherit",
});
const after = snapshot();

const dirtied = [];
for (const [file, stamp] of after) {
  if (ALLOWED.has(file)) continue;
  if (!before.has(file)) dirtied.push(`${file} (created)`);
  else if (before.get(file) !== stamp) dirtied.push(`${file} (modified)`);
}
for (const [file] of before) if (!after.has(file) && !ALLOWED.has(file)) dirtied.push(`${file} (deleted)`);

if (dirtied.length) {
  console.error("\n[data-guard] tests wrote into the REAL data directory:");
  for (const file of dirtied) console.error(`  - ${file}`);
  console.error("[data-guard] inject a temp store in the test instead. Refusing to pass.");
  process.exit(1);
}
process.exit(result.status ?? 1);
