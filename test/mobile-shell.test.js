// The app was unusable on a phone in ways nobody could see from the code.
//
// `.main` set overflow-x: hidden, which reads like a guard and behaved like a
// shredder: at 375px content ran to x=525 and the part past the edge was not
// scrollable, it was gone. Nineteen hardcoded 100vh put the chat composer under
// the iOS toolbar. There were no safe-area insets at all, seventeen breakpoints
// with no system behind them, a drawer with no scrim and no way out by keyboard,
// and `.search { display: none }` removed the only route to global search.
//
// Each check below is the shape of one of those. As in design-tokens.test.js the
// inputs are strings, so nothing here can pass by reading the machine it is on.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const STYLES = read("assets/css/styles.css");
const TOKENS = read("assets/css/tokens.css");
const INDEX = read("index.html");
const APP = read("assets/js/app.js");

const uncomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// Declaration blocks, with the media condition they sit under.
function rules(css) {
  const out = [];
  const src = uncomment(css);
  const re = /(@media[^{]+)\{|([^{}]+)\{([^{}]*)\}|\}/g;
  const media = [];
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) { media.push(m[1].trim()); continue; }
    if (m[0] === "}") { media.pop(); continue; }
    out.push({ media: media[media.length - 1] || "", selector: m[2].trim(), body: m[3] });
  }
  return out;
}

test("nothing sizes itself with a viewport unit the phone lies about", () => {
  // 100vh is the tallest the viewport ever gets, so on a phone it is always
  // wrong while the toolbar is showing. Each declaration keeps its vh line as
  // the fallback for old browsers and gains a dvh or svh twin right after.
  // Every plain-vh declaration must be immediately followed by the same
  // property in a modern unit. Counting both and comparing catches a twin that
  // was added in the wrong place as well as one that was never added.
  const css = uncomment(STYLES);
  // `\bvh\b` looks right and matches nothing: in "100vh" the character before
  // "vh" is a digit, and a digit-to-letter transition is not a word boundary,
  // so that pattern silently found zero declarations and every assertion built
  // on it passed vacuously. The lookbehind is the honest version — anything but
  // a letter in front, which admits "100vh" and excludes "100dvh"/"100svh".
  const PLAIN = /(min-height|max-height|height)\s*:\s*([^;]*?(?<![a-z])vh\b[^;]*);/g;
  const MODERN = /(min-height|max-height|height)\s*:\s*([^;]*?(?<![a-z])(?:dvh|svh)\b[^;]*);/g;

  const plain = [...css.matchAll(PLAIN)];
  const modern = [...css.matchAll(MODERN)];
  assert.ok(plain.length > 10, `only ${plain.length} vh declarations found — the pattern is not matching`);
  assert.equal(modern.length, plain.length,
    `${plain.length} plain-vh declarations but ${modern.length} modern twins`);

  const orphans = plain
    .filter((m) => {
      const rest = css.slice(m.index + m[0].length, m.index + m[0].length + 120);
      return !new RegExp(`^\\s*${m[1]}\\s*:\\s*[^;]*?(?<![a-z])(dvh|svh)\\b`).test(rest);
    })
    .map((m) => `${m[1]}: ${m[2]}`);
  assert.deepEqual(orphans, [], "the modern twin has to sit directly after the fallback");
});

test("a minimum uses svh and a cover uses dvh", () => {
  // dvh grows when the browser toolbar retracts. On a min-height that means the
  // page reflows mid-scroll under the reader's thumb; on something that must
  // cover the screen exactly it is the only unit that stays correct.
  const found = [...uncomment(STYLES).matchAll(
    /(min-height|max-height|height)\s*:\s*([^;]*?(?<![a-z])(?:dvh|svh)\b[^;]*);/g,
  )];
  assert.ok(found.length > 10, `only ${found.length} modern declarations found — the pattern is not matching`);
  const wrong = [];
  for (const [, prop, value] of found) {
    const unit = /svh/.test(value) ? "svh" : "dvh";
    if (prop === "min-height" && unit !== "svh") wrong.push(`${prop} should use svh: ${value}`);
    if (prop !== "min-height" && unit !== "dvh") wrong.push(`${prop} should use dvh: ${value}`);
  }
  assert.deepEqual(wrong, []);
});

test(".main does not clip what it cannot fit", () => {
  const main = rules(STYLES).find((r) => r.selector === ".main" && !r.media);
  assert.ok(main, "the .main rule moved — re-point this test");
  assert.doesNotMatch(main.body, /overflow-x:\s*hidden/,
    "hiding the overflow deletes the content; give the wide thing its own scroller instead");
  assert.match(main.body, /min-width:\s*0/, "without this the grid track blows out again");
});

test("wide content carries its own scroller", () => {
  // The three containment rules that let .main stop clipping.
  assert.match(STYLES, /\.grid > \* \{ min-width: 0; \}/,
    "a grid item defaults to min-width:auto, so one wide child pushes the track past the viewport");
  assert.match(STYLES, /\.tabs \{ overflow-x: auto;/, "a tab strip scrolls rather than pushing");
  assert.match(STYLES, /\.search \{[\s\S]*?min-width: 0;/, "the search field is what gives way in the topbar");
});

test("an icon has a size even where no rule gives it one", () => {
  // An SVG with a viewBox and no dimensions fills its container. Forty CSS
  // rules size icons per context and the rest fell back to 511px — invisible
  // for as long as .row could not wrap and flex shrank them back.
  // These are presentation attributes, so every existing rule still wins.
  const icons = read("assets/js/icons.js");
  assert.match(icons, /<svg\$\{cls\} width="1em" height="1em" viewBox="0 0 24 24"/,
    "icon() must emit intrinsic dimensions");
});

test("there are four breakpoints and they are the four that were chosen", () => {
  const allowed = new Set([640, 900, 1280, 1680]);
  const used = new Set(
    [...uncomment(STYLES).matchAll(/@media[^{]*\(\s*max-width:\s*(\d+)px\s*\)/g)].map((m) => Number(m[1])),
  );
  const stray = [...used].filter((w) => !allowed.has(w)).sort((a, b) => a - b);
  assert.deepEqual(stray, [], "seventeen ad-hoc widths is how this got unmaintainable the first time");
  // And the tokens file documents them, so the next person knows which four.
  for (const w of allowed) assert.match(TOKENS, new RegExp(`\\b${w}\\b`), `${w} should appear in the breakpoint note`);
});

test("the page opts into the notch and then pads itself back off it", () => {
  assert.match(INDEX, /viewport-fit=cover/, "env(safe-area-inset-*) reports zero without this");
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.match(TOKENS, new RegExp(`--safe-${side[0]}:\\s*env\\(safe-area-inset-${side}, 0px\\)`),
      `--safe-${side[0]} needs a 0px fallback or every calc() using it becomes invalid`);
  }
  // The three containers a person actually touches.
  const shell = rules(STYLES).filter((r) => /^(\.topbar|\.view|\.sidebar|body\.compact \.view)$/.test(r.selector));
  assert.ok(shell.length >= 4, "expected the shell rules to still be findable");
  for (const rule of shell) {
    if (!/padding/.test(rule.body)) continue;
    assert.match(rule.body, /--safe-/,
      `${rule.selector} sets padding without a safe-area inset — a padding shorthand here silently resets one`);
  }
});

test("layouts that fill the rest of the screen subtract the real bar height", () => {
  // .topbar is --topbar-h plus the top inset. Anything subtracting only
  // --topbar-h overshoots by exactly the notch.
  assert.doesNotMatch(uncomment(STYLES), /-\s*var\(--topbar-h\)/,
    "use --topbar-total, which includes the safe-area top");
  assert.match(TOKENS, /--topbar-total:\s*calc\(var\(--topbar-h\) \+ var\(--safe-t\)\)/);
});

test("the drawer is modal, dismissible and survives a keyboard", () => {
  // It used to slide over the page with nothing behind it: no dimming, nothing
  // to tap to dismiss, no Escape, and Tab walked straight out of the open
  // drawer into a page the person could not see.
  assert.match(STYLES, /\.nav-scrim \{/, "no scrim");
  assert.match(STYLES, /\.nav-scrim\.open \{ opacity: 1; pointer-events: auto; \}/);
  assert.match(STYLES, /body\.nav-open \{ overflow: hidden; \}/, "the page behind must not scroll");
  assert.match(APP, /function openNav\(/);
  assert.match(APP, /function closeNav\(/);
  assert.match(APP, /event\.key === "Escape"/, "Escape must close it");
  assert.match(APP, /event\.key !== "Tab"/, "focus has to be contained");
  assert.match(APP, /aria-expanded/, "the toggle has to say whether it is open");
  assert.match(APP, /scrim\.onclick = closeNav/, "tapping the page must dismiss it");
  assert.match(APP, /touchmove/, "and a drag to the left must dismiss it");
});

test("global search is reachable without a keyboard", () => {
  // The field was simply hidden below 640, which left ⌘K as the only way in.
  assert.match(STYLES, /\.search-compact \{ display: none; \}/);
  assert.match(STYLES, /\.search-compact \{ display: grid; \}/, "and shown on the phone");
  assert.match(APP, /id="globalSearchCompact"/);
  assert.match(APP, /gsc\.onclick = openCommandPalette/);
  // On a phone the palette is the screen, not a 600px dialog floating 90px down.
  assert.match(STYLES, /\.cmdk \{\s*top: 0; left: 0; right: 0; bottom: 0;/);
});

test("a finger can hit what a mouse can hit", () => {
  const css = uncomment(STYLES);
  // There is more than one coarse-pointer block — the tooltip keeps its rule
  // beside the tooltip. Collect them all; the union is what a finger gets.
  const blocks = [];
  for (let at = css.indexOf("@media (pointer: coarse)"); at !== -1; at = css.indexOf("@media (pointer: coarse)", at + 1)) {
    // Count braces: these blocks contain nested rules, so the first closing
    // brace is not the one that ends them.
    let depth = 0, end = at;
    for (let i = css.indexOf("{", at); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { end = i; break; }
    }
    blocks.push(css.slice(at, end));
  }
  assert.ok(blocks.length, "no coarse-pointer rules at all");
  const all = blocks.join("\n");
  for (const target of [".icon-btn", ".nav-item", ".tab", ".menu-item"]) {
    assert.ok(all.includes(target), `${target} has no touch sizing`);
  }
  assert.match(all, /min-height: 44px/, "44px is the target size a finger needs");
});

test("the tooltip does not exist until it is wanted", () => {
  // It used to be a permanent nowrap box at opacity 0 hanging off the side of
  // its button. Absolutely positioned descendants still count toward a scroll
  // container's extent, so a 36px icon button pushed the page 12px wider than
  // the phone — invisible while .main was clipping.
  assert.match(STYLES, /\.tip\[data-tip\]::after \{\s*content: none;/);
  assert.match(STYLES, /\.tip:hover\[data-tip\]::after,[\s\S]{0,80}\{ content: attr\(data-tip\); \}/);
});
