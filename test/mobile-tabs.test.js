// The phone shell, and the contract that keeps the two runtimes one product.
//
// Below the tablet breakpoint the drawer was the only navigation in the web
// app, and a drawer is a thing you have to already know is there. The Flutter
// app had a bottom bar and a completely unrelated palette — not one colour
// matched the web's, so a person who used both was using two products.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { exportTokens, parseThemes, resolve, SHARED, toDart } from "../scripts/export-design-tokens.mjs";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const APP = read("assets/js/app.js");
const STYLES = read("assets/css/styles.css");
const TOKENS = read("assets/css/tokens.css");
const EXPORTED = JSON.parse(read("assets/design-tokens.json"));

function sliceOf(source, name) {
  const start = source.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `${name} moved — re-point this test`);
  let depth = 0, end = start;
  for (let i = source.indexOf("[", start); i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]" && --depth === 0) { end = i + 1; break; }
  }
  return source.slice(start, end);
}

const bottomOf = (name) =>
  [...sliceOf(APP, name).matchAll(/\{ id: "([a-z]+)"[^\n]*bottom: true/g)].map((m) => m[1]);

/* ---------------- the bar ---------------- */

test("every role gets exactly four thumb-reachable sections", () => {
  // Four plus the orb is five slots. A fifth section would either shrink the
  // targets below a finger or push the orb off centre.
  assert.deepEqual(bottomOf("OPERATOR_SECTIONS"), ["today", "work", "business", "chat"]);
  assert.deepEqual(bottomOf("MEMBER_SECTIONS"), ["business", "today", "inbox", "chat"]);
  assert.deepEqual(bottomOf("DESIGN_SECTIONS"), ["today", "work", "studio", "chat"]);
});

test("the bar is two, the orb, then two", () => {
  // Same shape as the Flutter app's bar, which already split its four this way.
  assert.match(APP, /\$\{bottom\.slice\(0, 2\)\.map\(tab\)\.join\(""\)\}/);
  assert.match(APP, /\$\{orb\}/);
  assert.match(APP, /\$\{bottom\.slice\(2\)\.map\(tab\)\.join\(""\)\}/);
  assert.match(STYLES, /\.tabbar \{[^}]*grid-template-columns: repeat\(5, 1fr\)/s);
});

test("the bar only exists where the rail does not", () => {
  assert.match(STYLES, /\.tabbar \{ display: none; \}/);
  // The block that turns it on. Matched with \r?\n because this file is CRLF
  // and a bare \n quietly matches nothing.
  assert.match(STYLES, /@media \(max-width: 900px\) \{\r?\n\s*\.tabbar \{[^}]*display: grid;/,
    "the bar has to appear at exactly the width the rail leaves the flow");
});

test("content and the dock both clear the bar", () => {
  // A bar that floats over the page hides the last row of whatever is under it.
  assert.match(STYLES, /\.view \{ padding-bottom: calc\(24px \+ var\(--tabbar-h\) \+ var\(--safe-b\)\); \}/);
  assert.match(STYLES, /\.mila-dock \{ bottom: calc\(12px \+ var\(--tabbar-h\) \+ var\(--safe-b\)\); \}/);
  // And the bar itself clears the gesture indicator.
  assert.match(STYLES, /height: calc\(var\(--tabbar-h\) \+ var\(--safe-b\)\)/);
});

test("a tab is big enough to hit and says what it is", () => {
  assert.match(STYLES, /\.tab-item \{[^}]*min-height: 52px;/);
  assert.match(APP, /\$\{icon\(section\.icon\)\}<span>\$\{sectionLabel\(section\)\}<\/span>/);
  // Absent, not zero.
  assert.match(STYLES, /\.tab-count\[hidden\] \{ display: none; \}/);
  assert.match(APP, /\["#tabNeeds", "tab-count"\]/, "the queue count reaches the bar too");
});

test("the orb is only there for someone who has MILA", () => {
  // Design does not get Mila Live; the slot collapses rather than linking to a
  // page that would render forbidden.
  assert.match(APP, /pages\(\)\.mila\s*\r?\n?\s*\? `<a class="tab-orb" href="#\/mila"/);
  assert.match(APP, /tab-orb-spacer/);
});

/* ---------------- one palette, two runtimes ---------------- */

test("the exported palette is what tokens.css actually says", () => {
  // The JSON is committed so the phone can be built without running the web
  // app's toolchain. That only helps if it cannot drift.
  const fresh = exportTokens(TOKENS);
  assert.deepEqual(EXPORTED.dark, fresh.dark, "assets/design-tokens.json is stale — rerun scripts/export-design-tokens.mjs");
  assert.deepEqual(EXPORTED.light, fresh.light, "assets/design-tokens.json is stale — rerun scripts/export-design-tokens.mjs");
});

test("every shared token resolves to a real colour in both themes", () => {
  const themes = parseThemes(TOKENS);
  for (const theme of ["dark", "light"]) {
    for (const token of SHARED) {
      const value = resolve(themes[theme], token);
      assert.match(value, /^#[0-9a-f]{6}$/i, `${token} in ${theme} is ${value}, which Dart cannot hold`);
    }
  }
});

test("the generated Dart is valid and complete", () => {
  const dart = toDart(EXPORTED);
  assert.match(dart, /^\/\/ GENERATED — do not edit\./);
  assert.match(dart, /abstract final class MilaTokensDark \{/);
  assert.match(dart, /abstract final class MilaTokensLight \{/);
  // Every token, as an opaque ARGB literal.
  for (const token of SHARED) {
    const name = token.replace(/^--/, "").replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    assert.match(dart, new RegExp(`static const ${name} = Color\\(0xFF[0-9A-F]{6}\\);`), `${name} missing from the Dart output`);
  }
  assert.equal((dart.match(/static const/g) || []).length, SHARED.length * 2);
});

test("the phone's palette is the web's palette", () => {
  // The values that used to differ, every one of them. This is the check that
  // would have caught the drift in the first place.
  const dark = EXPORTED.dark;
  const wasDifferent = {
    "--bg": "#0d111b", "--surface": "#1a1f2e", "--primary": "#7b61ff",
    "--text-2": "#9aa3b5", "--text-3": "#5d6678", "--success": "#35d49b",
  };
  for (const [token, old] of Object.entries(wasDifferent)) {
    assert.notEqual(dark[token], old, `${token} is back to the app's old value`);
  }
  assert.equal(dark["--bg"], "#080b14");
  assert.equal(dark["--surface"], "#10151f");
  assert.equal(dark["--text-3"], "#8b96a8", "the app's old tertiary was 2.84:1");
});
