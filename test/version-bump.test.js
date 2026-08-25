// The version in package.json never moved in the life of this repository, and
// /api/health reported a literal "1.0.0" that was not read from anywhere. Both
// halves of that are now load-bearing: the endpoint reports the real field, and
// a change that reaches production has to move it.
//
// The interesting cases are in a pure function, so they are tested as data
// rather than by building throwaway commits.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  SHIPPING, compareVersions, explain, parseVersion, shippingChanges, verdict,
} from "../scripts/check-version-bump.mjs";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("only what reaches production counts as a shipping change", () => {
  const ships = shippingChanges([
    "server/index.js", "assets/css/styles.css", "index.html",
    "agentos-runtime/dashboard/backend/app.py", "package.json", "Dockerfile",
  ]);
  assert.equal(ships.length, 6);

  // A browser and the image are both unaware of these.
  assert.deepEqual(shippingChanges([
    "test/version-bump.test.js", "docs/PLAN.md", ".github/workflows/ci.yml",
    "scripts/check-version-bump.mjs", "README.md", "vault/note.md",
  ]), []);
});

test("a prefix match cannot be fooled by a lookalike path", () => {
  // "server/" must not match "servers-i-once-had.md", and an exact entry like
  // "package.json" must not match "package.json.bak".
  assert.deepEqual(shippingChanges(["servers-i-once-had.md", "package.json.bak", "assetsomething.js"]), []);
  assert.deepEqual(shippingChanges(["assets/js/app.js"]), ["assets/js/app.js"]);
});

test("versions compare by number, not by string", () => {
  // "1.10.0" > "1.9.0" is false for a string comparison and true for a version.
  assert.equal(compareVersions("1.9.0", "1.10.0"), -1);
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(parseVersion("2.0.0-rc.1")?.join("."), "2.0.0");
  assert.equal(parseVersion("not a version"), null);
  assert.equal(compareVersions("x", "1.0.0"), null);
});

test("a shipping change with no bump is refused, and says why", () => {
  const v = verdict({ files: ["server/index.js"], baseVersion: "1.0.0", headVersion: "1.0.0" });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "unchanged");
  assert.match(explain(v), /the version does not move/);
  assert.match(explain(v), /server\/index\.js/, "it has to name the files it is talking about");
});

test("a version that goes backwards is refused separately", () => {
  const v = verdict({ files: ["assets/js/app.js"], baseVersion: "1.4.0", headVersion: "1.3.9" });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "went-backwards");
  assert.match(explain(v), /went backwards/);
});

test("test-only and docs-only changes are let through", () => {
  for (const files of [["test/a.test.js"], ["docs/x.md"], [".github/workflows/ci.yml"], []]) {
    const v = verdict({ files, baseVersion: "1.0.0", headVersion: "1.0.0" });
    assert.equal(v.ok, true, `${JSON.stringify(files)} should not need a bump`);
    assert.equal(v.reason, "no-shipping-changes");
  }
});

test("a real bump is accepted", () => {
  const v = verdict({ files: ["server/index.js"], baseVersion: "1.0.0", headVersion: "1.1.0" });
  assert.equal(v.ok, true);
  assert.equal(v.reason, "bumped");
});

test("an unreadable version here is a failure, on the base it is not", () => {
  // Missing on the base means there is nothing to compare against — a new
  // repository, or the field only just introduced. Missing here is a broken
  // package.json and should be said out loud.
  assert.equal(verdict({ files: ["server/a.js"], baseVersion: null, headVersion: "1.0.0" }).ok, true);
  const bad = verdict({ files: ["server/a.js"], baseVersion: "1.0.0", headVersion: null });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "unreadable-head-version");
});

test("/api/health reports the field rather than a literal", () => {
  const index = read("server/index.js");
  assert.match(index, /const VERSION = \(\(\) => \{/);
  assert.match(index, /JSON\.parse\(fs\.readFileSync\(path\.join\(ROOT, "package\.json"\)/);
  assert.match(index, /name: "agentic-os", version: VERSION,/);
  // The literal it replaced must not come back, in that field or any other.
  assert.doesNotMatch(index, /version: "\d+\.\d+\.\d+"/,
    "a hardcoded version drifts from package.json the moment either one moves");
});

test("the version the endpoint would report is the one package.json declares", () => {
  const declared = JSON.parse(read("package.json")).version;
  assert.ok(parseVersion(declared), `package.json version ${JSON.stringify(declared)} is not x.y.z`);
  // And every shipping prefix the checker names still exists, or the check is
  // quietly guarding nothing.
  for (const p of SHIPPING) {
    const rel = p.endsWith("/") ? p.slice(0, -1) : p;
    assert.ok(fs.existsSync(new URL(`../${rel}`, import.meta.url)),
      `${p} is in the shipping list but not in the repository`);
  }
});

test("the version on screen is the running one, not a picture", () => {
  // The badge in the sidebar read the literal "v1.0" for the life of the
  // repository, beside an /api/health that reported "1.0.0" from a different
  // literal. Fixing only the endpoint left the number people actually look at
  // frozen, which is exactly how it stayed wrong without anyone noticing.
  const app = read("assets/js/app.js");
  assert.match(app, /function versionBadge\(\) \{/);
  assert.match(app, /const version = api\.health\?\.version;/);
  assert.doesNotMatch(app, /class="brand-badge">v\d/,
    "the badge is a literal again");
  // Absent rather than stale when the server cannot be reached: a number that
  // used to be true is worse than no number.
  assert.match(app, /if \(!version\) return "";/);
});

test("no surface reports a version it did not read", () => {
  // Three places have claimed to know the version: the endpoint, the badge and
  // package.json. Only the last one is allowed to be a literal.
  for (const file of ["server/index.js", "assets/js/app.js"]) {
    const source = read(file).replace(/\/\/.*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(source, /version: "\d+\.\d+\.\d+"/,
      `${file} carries a hardcoded version`);
  }
});
