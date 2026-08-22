// Three defects the redesign shipped, all of them in the chrome around the
// pages rather than in any page:
//
//   1. Between the tablet and desktop breakpoints the *closed* section flyout
//      sat on top of the rail — opaque, above it in the stacking order, and
//      swallowing the click on every nav item. The rail was unusable and
//      looked fine, which is the worst combination.
//   2. The rail's avatar and the section column's user chip both open the same
//      menu, and at most widths both were on screen: two account buttons a few
//      pixels apart.
//   3. Nothing in the stylesheet declared color-scheme, so the browser drew
//      native <select> popups light under a dark page. The language picker
//      handed near-white text to a white popup and the options read as blank.
//
// The first is a geometry bug, so the geometry is what gets checked here —
// the declared offset, width and transform are resolved and the resulting
// edge compared against the rail. A test that only looked for the word
// "calc" would have passed on the broken version too.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const STYLES = read("assets/css/styles.css");
const TOKENS = read("assets/css/tokens.css");

// Slice `@media (...)` blocks out of the sheet, brace-counted so a nested rule
// cannot end one early. This stylesheet repeats each breakpoint many times —
// thirteen blocks share max-width: 900px — so the caller says which one it
// means by naming something inside it. Taking the first match silently tests
// the wrong block, which is how the first draft of this file passed while
// looking at a rule about the brand mark.
function mediaBlocks(condition) {
  const head = `@media (${condition}) {`;
  const found = [];
  let from = 0;
  for (;;) {
    const start = STYLES.indexOf(head, from);
    if (start === -1) break;
    let depth = 0, closed = false;
    for (let i = start + head.length - 1; i < STYLES.length; i++) {
      if (STYLES[i] === "{") depth++;
      else if (STYLES[i] === "}" && --depth === 0) {
        found.push(STYLES.slice(start, i));
        from = i;
        closed = true;
        break;
      }
    }
    if (!closed) throw new Error(`@media (${condition}) is not closed`);
  }
  assert.notEqual(found.length, 0, `@media (${condition}) moved — re-point this test`);
  return found;
}

function mediaBlock(condition, containing) {
  const blocks = mediaBlocks(condition).filter((b) => b.includes(containing));
  assert.equal(blocks.length, 1,
    `expected one @media (${condition}) block containing ${JSON.stringify(containing)}, found ${blocks.length}`);
  return blocks[0];
}

// One rule's body. [^}]* rather than a lazy any-character match, which walks
// out of the rule and satisfies itself from the next one. Spaces inside the
// selector become "any whitespace" after escaping, so a descendant selector
// still matches when the source happens to wrap it differently.
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ +/g, "\\s+");
  const m = css.match(new RegExp(`(^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, "m"));
  assert.ok(m, `${selector} not found in this block`);
  return m[2];
}

const tokenPx = (name) => {
  const m = TOKENS.match(new RegExp(`${name}:\\s*(-?[\\d.]+)px`));
  assert.ok(m, `${name} is not declared in tokens.css`);
  return Number(m[1]);
};

// Everything between `name(` and its matching close paren. Depth-counted:
// stripping parens with a blanket replace eats the one closing var(--rail-w)
// too, and the term then falls out of the sum entirely — which is exactly how
// the first version of this test reported 62px for a value the browser
// resolves to -6px.
function insideCall(expr, name) {
  const open = expr.indexOf(`${name}(`);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open + name.length; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    else if (expr[i] === ")" && --depth === 0) return expr.slice(open + name.length + 1, i);
  }
  return null;
}

// Resolve the small subset of calc() this stylesheet uses for the flyout:
// a percentage of the element's own width, px literals, and custom properties.
function resolveTranslateX(expr, selfWidth) {
  let body = insideCall(expr, "translateX");
  assert.ok(body !== null, `could not parse ${expr}`);
  body = (insideCall(body, "calc") ?? body).trim();

  let total = 0, terms = 0;
  for (const [, sign, term] of body.matchAll(/([+-]?)\s*([\d.]+%|[\d.]+px|var\(--[a-z-]+\))/g)) {
    let value;
    if (term.endsWith("%")) value = (parseFloat(term) / 100) * selfWidth;
    else if (term.endsWith("px")) value = parseFloat(term);
    else value = tokenPx(term.slice(4, -1));
    total += (sign === "-" ? -1 : 1) * value;
    terms++;
  }
  assert.ok(terms > 0, `no resolvable terms in ${expr} — the parser has fallen behind the stylesheet`);
  return total;
}

test("the closed section flyout is actually off screen, not parked on the rail", () => {
  const block = mediaBlock("max-width: 1280px", ".sectionnav {");
  const body = ruleBody(block, ".sectionnav");

  assert.match(body, /position:\s*absolute/);
  const left = body.match(/left:\s*var\(--([a-z-]+)\)/);
  assert.ok(left, "the flyout is expected to be offset by the rail width");
  const leftPx = tokenPx(`--${left[1]}`);
  const width = Number(body.match(/width:\s*([\d.]+)px/)[1]);
  const transform = body.match(/transform:\s*([^;]+);/)[1];

  const shift = resolveTranslateX(transform, width);
  const rightEdge = leftPx + width + shift;

  // Anything greater than zero is panel still on screen, and because it is
  // opaque and sits at z-index 91 every pixel of it is a dead click on the
  // rail underneath.
  assert.ok(rightEdge <= 0,
    `the closed flyout's right edge is at ${rightEdge}px — it covers ${Math.min(rightEdge, leftPx)}px ` +
    `of the ${leftPx}px rail. Sliding it by its own width is not enough when it starts at left:${leftPx}px.`);

  // And it must still open all the way.
  assert.match(block, /\.sidebar\.expanded \.sectionnav \{ transform: none; \}/);
});

test("the flyout sits above the rail, which is why the overlap mattered", () => {
  // Not a style preference — it is the reason a few stray pixels became a
  // dead rail rather than a cosmetic seam. If either of these stops being
  // true the geometry test above is guarding something less severe.
  const body = ruleBody(mediaBlock("max-width: 1280px", ".sectionnav {"), ".sectionnav");
  assert.match(body, /z-index:\s*9\d/);
  assert.match(body, /background:\s*var\(--bg-1\)/, "an opaque ground is what hides the rail");
});

test("exactly one account control is on screen at every width", () => {
  // The rail avatar and the section column's chip open the same menu. Which
  // one is right depends on whether the column is visible, so each breakpoint
  // has to make its own choice — and every breakpoint has to make one.
  const wide = STYLES.slice(0, STYLES.indexOf("@media"));
  assert.match(wide, /\.rail-foot #user-menu \{ display: none; \}/,
    "wide: the column is static and carries the full chip, so the rail avatar is a duplicate");
  assert.match(mediaBlock("max-width: 1280px", ".sectionnav {"), /\.rail-foot #user-menu \{ display: grid; \}/,
    "flyout range: the chip is behind a tap, so the rail has to carry the account");
  assert.match(mediaBlock("max-width: 900px", ".rail-foot #user-menu"), /\.rail-foot #user-menu \{ display: none; \}/,
    "drawer: both columns are visible again, so the chip is back and the avatar duplicates it");
});

test("the orb is not caught by the account rule", () => {
  // Mila lives in the same .rail-foot. Hiding the avatar must not hide her —
  // she has already gone missing once.
  assert.doesNotMatch(STYLES, /\.rail-foot \{[^}]*display: none/);
  assert.doesNotMatch(STYLES, /\.rail-foot [^#\n{]*\{ display: none; \}/,
    "only #user-menu may be hidden inside the rail foot");
});

test("native controls follow the theme instead of staying light", () => {
  // <select> popups, scrollbars and date pickers are drawn by the browser.
  // Without color-scheme it draws them light whatever the page does, and the
  // language picker's inherited near-white text landed on a white popup.
  const dark = TOKENS.slice(TOKENS.indexOf(':root[data-theme="dark"]'), TOKENS.indexOf(':root[data-theme="light"]'));
  const light = TOKENS.slice(TOKENS.indexOf(':root[data-theme="light"]'));
  assert.match(dark, /color-scheme:\s*dark;/, "the dark theme must tell the browser it is dark");
  assert.match(light, /color-scheme:\s*light;/);
});

test("every option list names its own two ends", () => {
  // The option list inherits the select, not the box drawn around it, and
  // three selects here sit on a transparent background.
  assert.match(STYLES, /select option \{[^}]*background-color: var\(--surface\)[^}]*color: var\(--text\)/);
  for (const control of [".ui-language select", ".login-language select"]) {
    const body = ruleBody(STYLES, control);
    assert.match(body, /align-self: stretch/,
      `${control} must fill its chip — half-height means half the control does nothing`);
  }
});
