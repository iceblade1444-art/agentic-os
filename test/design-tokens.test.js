// The palette had been chosen against a near-black ground and reused unchanged
// on white, so in the light theme "Degraded" rendered at 2.15:1 and "Healthy" at
// 2.28:1 — both unreadable, both shipped. Nothing caught it because nothing was
// looking, so this is the thing that looks.
//
// Every check here takes its CSS as a parameter with the real file as the
// default. That is deliberate: this repo keeps producing tests that read ambient
// state and pass on a laptop while the server disagrees. A pure function over a
// string cannot do that, and it lets the failure cases below be exercised
// directly rather than described.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const TOKENS = read("assets/css/tokens.css");
const STYLES = read("assets/css/styles.css");

/* ---------- contrast ---------- */

export function channels(hex) {
  const raw = String(hex).trim().replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

export function luminance(rgb) {
  const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}

export function contrast(a, b) {
  const [x, y] = [channels(a), channels(b)];
  if (!x || !y) throw new Error(`not a hex colour: ${!x ? a : b}`);
  const [l1, l2] = [luminance(x), luminance(y)];
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/* ---------- token parsing ---------- */

// Comments come out first. A block's selector is "everything since the last
// closing brace", so a comment sitting above `:root` becomes part of its
// selector and the base block stops being recognised as the base block.
export const uncomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// Blocks are `selector { body }`. The file declares three: the base, the dark
// override (which the base selector joins) and the light override.
export function blocks(css) {
  const found = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(uncomment(css)))) found.push({ selector: m[1].trim(), body: m[2] });
  return found;
}

export function declarations(body) {
  const out = new Map();
  for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out.set(name, value.trim());
  }
  return out;
}

// A theme is the base block plus whichever override names it.
export function theme(css, name) {
  const merged = new Map();
  for (const block of blocks(css)) {
    const selects = block.selector
      .split(",")
      .map((s) => s.trim())
      .some((s) => s === ":root" || s === `:root[data-theme="${name}"]`);
    if (!selects) continue;
    for (const [k, v] of declarations(block.body)) merged.set(k, v);
  }
  return merged;
}

// `--primary: var(--violet-600)` has to become a colour before it can be measured.
export function resolve(tokens, name, depth = 0) {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`undefined token ${name}`);
  if (depth > 8) throw new Error(`token ${name} references itself`);
  const ref = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value);
  return ref ? resolve(tokens, ref[1], depth + 1) : value;
}

/* ---------- the rules ---------- */

// A token must clear its floor on every ground it can land on, not on the one
// ground somebody happened to check. --surface-3 is the quiet failure: it is the
// lightest dark surface and the darkest light one, so it is where a value that
// passes everywhere else gives out.
const GROUNDS = ["--bg", "--bg-1", "--surface", "--surface-2", "--surface-3", "--elevated"];

// Text. WCAG AA for body copy.
const INK = ["--text", "--text-2", "--text-3", "--primary-ink",
  "--success-ink", "--warning-ink", "--error-ink", "--info-ink", "--teal-ink"];

// Boundaries and indicators. WCAG AA for non-text contrast.
const BOUNDARY = ["--border-interactive", "--ring"];

// Something white sits on top of these.
const WHITE_ON = ["--primary", "--danger-fill"];

for (const name of ["dark", "light", "command"]) {
  test(`${name} theme: every ink token is readable on every surface`, () => {
    const tokens = theme(TOKENS, name);
    for (const ink of INK) {
      for (const ground of GROUNDS) {
        const ratio = contrast(resolve(tokens, ink), resolve(tokens, ground));
        assert.ok(ratio >= 4.5, `${ink} on ${ground} is ${ratio}:1, needs 4.5 — ${name} theme`);
      }
    }
  });

  test(`${name} theme: boundaries that carry meaning are perceivable`, () => {
    const tokens = theme(TOKENS, name);
    for (const edge of BOUNDARY) {
      for (const ground of GROUNDS) {
        const ratio = contrast(resolve(tokens, edge), resolve(tokens, ground));
        assert.ok(ratio >= 3, `${edge} on ${ground} is ${ratio}:1, needs 3 — ${name} theme`);
      }
    }
  });

  test(`${name} theme: white text on a solid fill still reads`, () => {
    const tokens = theme(TOKENS, name);
    for (const fill of WHITE_ON) {
      const ratio = contrast("#ffffff", resolve(tokens, fill));
      assert.ok(ratio >= 4.5, `white on ${fill} is ${ratio}:1, needs 4.5 — ${name} theme`);
    }
  });

  test(`${name} theme: wherever styles.css actually puts white on a fill, it reads`, () => {
    // Checking the token is not enough. .btn-danger was white on --error at
    // 3.76:1, and a rule that only measured --danger-fill stayed green while the
    // button went on failing — the token was right and the button did not use it.
    const tokens = theme(TOKENS, name);
    const failures = [];
    for (const { selector, body } of blocks(STYLES)) {
      const fill = /background:\s*var\((--[a-z0-9-]+)\)/.exec(body);
      const white = /color:\s*(#fff\b|#ffffff\b|var\(--text-inv\))/.test(body);
      if (!fill || !white) continue;
      let value;
      try { value = resolve(tokens, fill[1]); } catch { continue; }
      if (!channels(value)) continue;
      const ratio = contrast("#ffffff", value);
      if (ratio < 4.5) failures.push(`${selector.split("\n").pop().trim()} — white on ${fill[1]} (${value}) is ${ratio}:1`);
    }
    assert.deepEqual(failures, [], `white label on a fill that cannot carry it — ${name} theme`);
  });
}

test("the bright fills stay bright, because dark ink is hardcoded on them", () => {
  // styles.css sets `background: var(--warning); color: #2b1a02` and the green
  // equivalent. Darkening a fill to make it pass as text would silently break
  // these, which is the whole reason ink and fill are separate tokens.
  const dark = theme(TOKENS, "dark");
  const pairs = [["#2b1a02", "--warning"], ["#04240f", "--success"]];
  for (const [ink, fill] of pairs) {
    const value = resolve(dark, fill);
    assert.ok(
      STYLES.includes(`background: var(${fill}); color: ${ink};`),
      `expected styles.css to still put ${ink} on ${fill} — re-point this test if that moved`,
    );
    const ratio = contrast(ink, value);
    assert.ok(ratio >= 4.5, `${ink} on ${fill} (${value}) is ${ratio}:1, needs 4.5`);
  }
});

test("nothing renders below the 12px floor", () => {
  const sources = [
    ["assets/css/styles.css", STYLES],
    ["assets/css/tokens.css", TOKENS],
    ...fs.readdirSync(new URL("../assets/js", import.meta.url))
      .filter((f) => f.endsWith(".js"))
      .map((f) => [`assets/js/${f}`, read(`assets/js/${f}`)]),
    ...fs.readdirSync(new URL("../assets/js/pages", import.meta.url))
      .filter((f) => f.endsWith(".js"))
      .map((f) => [`assets/js/pages/${f}`, read(`assets/js/pages/${f}`)]),
  ];
  const offenders = [];
  for (const [name, text] of sources) {
    for (const [, size] of text.matchAll(/font-size:\s*([0-9.]+)px/g)) {
      if (parseFloat(size) < 12) offenders.push(`${name}: ${size}px`);
    }
    for (const [, size] of text.matchAll(/font-size="([0-9.]+)"/g)) {
      if (parseFloat(size) < 12) offenders.push(`${name}: svg ${size}`);
    }
  }
  assert.deepEqual(offenders, [], `text below 12px is not legible on a factory floor:\n${offenders.join("\n")}`);
});

test("every custom property the app reads is one the app defines", () => {
  // --success-soft, --warning-soft, --error-soft and --info-soft were read in
  // eight places and defined nowhere, so those backgrounds silently rendered
  // transparent. An undefined token fails as silence, which is why it lasted.
  const defined = new Set();
  for (const css of [TOKENS, STYLES]) {
    for (const [, name] of css.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(name);
  }
  const js = [
    ...fs.readdirSync(new URL("../assets/js", import.meta.url)).filter((f) => f.endsWith(".js")).map((f) => read(`assets/js/${f}`)),
    ...fs.readdirSync(new URL("../assets/js/pages", import.meta.url)).filter((f) => f.endsWith(".js")).map((f) => read(`assets/js/pages/${f}`)),
  ];
  const missing = new Set();
  for (const source of [TOKENS, STYLES, ...js]) {
    for (const [, name] of source.matchAll(/var\(\s*(--[a-z0-9-]+)\s*[,)]/gi)) {
      if (!defined.has(name)) missing.add(name);
    }
  }
  assert.deepEqual([...missing].sort(), [], "these resolve to nothing at runtime");
});

test("semantic text points at ink, not at the fill beside it", () => {
  // The mechanical half of the fix. `color: var(--success)` is the shape the
  // failure took; if it comes back, it comes back at 2.28:1.
  const strays = [];
  for (const match of STYLES.matchAll(
    /(?:^|[;{\s])(color|border(?:-(?:top|right|bottom|left))?-color)\s*:\s*var\(--(success|warning|error|info|teal|primary)\)/g,
  )) {
    // A border on top of its own background is an edge, not a boundary; those
    // are allowed to stay on the fill.
    strays.push(`${match[1]}: var(--${match[2]})`);
  }
  const allowed = new Set([
    // .switch input:checked + .track, .mila-mic, .mila-end, .mila-dock-bubble —
    // each sets the same token as its own background.
    "border-color: var(--primary)",
  ]);
  assert.deepEqual(strays.filter((s) => !allowed.has(s)), [],
    "use the -ink token for text and for borders against a different ground");
});

test("an operator has one theme, and light mode cannot come back", () => {
  // The owner dropped light mode for the operator surface. The mapping
  // therefore ignores the stored value rather than trusting it — a "light"
  // saved before the change must not resurrect the old look — and the
  // toggles that could set it are not rendered for operators at all.
  const app = read("assets/js/app.js");
  assert.match(app, /const effectiveTheme = \(t\) => api\.auth\.canAdmin \? "command" : t/);
  assert.match(app, /\$\{api\.auth\.canAdmin \? "" : `<button class="icon-btn" id="themeBtn"/);
  assert.match(app, /if \(!api\.auth\.canAdmin\) cmds\.push\(\{ group: tr\("shell\.actions"\), icon: theme === "dark"/);
  assert.match(read("assets/js/pages/settings.js"), /\$\{api\.auth\.canAdmin \? "" : `<div class="section-title">\$\{t\("settings\.theme"\)\}/);
  // Member and Design still have both, so the light palette stays defined.
  assert.ok(theme(TOKENS, "light").size > 20, "the light theme is still built for the other roles");
  // And the Flutter export deliberately ignores the third block: parseThemes
  // reads only dark and light, so the phone's palette cannot drift from this.
  assert.match(read("scripts/export-design-tokens.mjs"), /themes = \{ dark: \{\}, light: \{\} \}/);
});

test("the command stage's literal palette holds the same ink floors", () => {
  // The stage is the one screen allowed to opt out of the token system, which
  // means it is also the one screen the theme tests cannot see. Same rules,
  // read from its own declarations in styles.css.
  const stage = blocks(STYLES).find((block) => block.selector.startsWith(".cmd-stage") && block.body.includes("--cmd-bg"));
  assert.ok(stage, "the stage palette block moved — re-point this test");
  const decls = declarations(stage.body);
  const ground = decls.get("--cmd-bg");
  for (const ink of ["--cmd-text", "--cmd-dim", "--cmd-faint", "--ember", "--ember-2", "--ember-3"]) {
    const ratio = contrast(decls.get(ink), ground);
    assert.ok(ratio >= 4.5, `${ink} on the stage black is ${ratio}:1, needs 4.5`);
  }
});
