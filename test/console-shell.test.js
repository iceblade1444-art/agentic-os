// The shell: six sections instead of twenty-six links, a queue above the
// metrics, a bell wired to something real, and a density preference that had
// existed in the store for a year without a way to express it.
//
// These read the source rather than a rendered DOM, in the same spirit as
// brand.test.js: what is being defended is that the structure stays the shape
// it was rebuilt into, and that nothing quietly grows back.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const APP = read("assets/js/app.js");
const STYLES = read("assets/css/styles.css");
const I18N = read("assets/js/i18n.js");

// Pull a section list out of the source. Reading the literal keeps this honest
// about what actually ships, rather than re-declaring the answer in the test.
function sectionsFrom(name) {
  const start = APP.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `${name} moved — re-point this test`);
  let depth = 0, end = start;
  for (let i = APP.indexOf("[", start); i < APP.length; i++) {
    if (APP[i] === "[") depth++;
    else if (APP[i] === "]" && --depth === 0) { end = i; break; }
  }
  const body = APP.slice(start, end);
  return [...body.matchAll(/\{ id: "([a-z]+)"/g)].map((m) => m[1]);
}

function routesFrom(name) {
  const start = APP.indexOf(`const ${name} = [`);
  let depth = 0, end = start;
  for (let i = APP.indexOf("[", start); i < APP.length; i++) {
    if (APP[i] === "[") depth++;
    else if (APP[i] === "]" && --depth === 0) { end = i; break; }
  }
  return [...APP.slice(start, end).matchAll(/route: "([a-z-]*)"/g)].map((m) => m[1]);
}

test("an operator sees six sections, not twenty-six links", () => {
  const ids = sectionsFrom("OPERATOR_SECTIONS");
  assert.deepEqual(ids, ["today", "work", "agents", "business", "library", "chat"]);
  // Six is the point. Seven is how it grew to twenty-six the first time.
  assert.ok(ids.length <= 6, `${ids.length} rail items — the rail is not a list`);
});

test("every destination the old flat list had still has a home", () => {
  // Nothing was removed, only regrouped. This is the check that keeps a
  // reorganisation from quietly becoming a deletion.
  const previously = [
    "", "personal", "missions", "hermes", "claude", "speech", "agents", "chat",
    "kanban", "routines", "tools", "test-apps", "knowledge", "memory", "mcp",
    "integrations", "design", "media", "analytics", "erp", "evaluations",
    "observability", "guardrails", "secrets",
  ];
  const now = new Set(routesFrom("OPERATOR_SECTIONS"));
  const lost = previously.filter((route) => !now.has(route));
  assert.deepEqual(lost, [], "these routes are in no section and reachable only by typing the URL");

  // Settings and the component library moved to the avatar menu rather than
  // vanishing, and MILA became the orb.
  assert.match(APP, /text: tr\("shell\.settings"\), icon: "settings"/);
  assert.match(APP, /shell\.componentLibrary/);
  assert.match(APP, /class="rail-orb tip"[^>]*href="#\/mila"/);
});

test("a Member's rail cannot reach an operator surface", () => {
  const memberRoutes = new Set(routesFrom("MEMBER_SECTIONS"));
  for (const operatorOnly of ["kanban", "hermes", "claude", "agents", "secrets", "guardrails", "mcp"]) {
    assert.equal(memberRoutes.has(operatorOnly), false, `${operatorOnly} is in the Member rail`);
  }
  const designRoutes = new Set(routesFrom("DESIGN_SECTIONS"));
  for (const operatorOnly of ["kanban", "hermes", "claude", "agents", "secrets", "analytics"]) {
    assert.equal(designRoutes.has(operatorOnly), false, `${operatorOnly} is in the Design rail`);
  }
});

test("the palette still reaches everything the rail no longer shows", () => {
  // A six-item rail is only honest if the other twenty are still findable by
  // name. The palette walks the flattened list, grouped by section.
  assert.match(APP, /navItems\(\)\.forEach\(\(it\) => cmds\.push\(\{/);
  assert.match(APP, /group: sectionLabel\(it\.section\)/);
});

test("every section and every child has a translation", () => {
  for (const list of ["OPERATOR_SECTIONS", "MEMBER_SECTIONS", "DESIGN_SECTIONS"]) {
    for (const id of sectionsFrom(list)) {
      assert.match(I18N, new RegExp(`"nav\\.sec\\.${id}":`), `nav.sec.${id} is missing`);
    }
  }
  // Three dictionaries, so three copies of each.
  for (const key of ["nav.sec.today", "nav.sec.work", "needs.title", "shell.density"]) {
    const count = [...I18N.matchAll(new RegExp(`"${key.replace(".", "\\.")}":`, "g"))].length;
    assert.equal(count, 3, `${key} appears ${count} times, expected one per locale`);
  }
});

test("the bell reads the inbox instead of four hardcoded strings", () => {
  // The mock shipped: "Agent task completed", "Rate limit approaching", and a
  // dot that was always lit, wired to nothing.
  // Matched as code, not as prose: the comment above openNotifications quotes
  // the strings it replaced, and a test that cannot tell the two apart would
  // fail on its own documentation.
  const code = APP.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const ghost of [
    "Agent task completed", "Content Writer · seo_check timed out",
    "New agent deployed", "Rate limit approaching",
  ]) {
    assert.equal(code.includes(ghost), false, `the mock notification "${ghost}" is still there`);
  }
  assert.doesNotMatch(code, /dot: "var\(--/, "the hardcoded dot colours went with it");
  assert.match(APP, /await api\.needsYou\(\)/);
  assert.match(APP, /dot\.hidden = total === 0/, "no dot when there is nothing");
});

test("the queue is a real request with a real empty state", () => {
  // The needs-you card and the Operational Home it sat on dissolved into the
  // Command Center (Ф4): the queue now lives in the stage's inbox panel and
  // sheet, and the same invariants ride along.
  assert.match(read("assets/js/api.js"), /needsYou: \(\) => j\("\/api\/needs-you"\)/);
  const command = read("assets/js/pages/command.js");
  assert.match(command, /api\.needsYou\(\)/, "the home must ask the same queue the bell reads");
  assert.match(command, /t\("needs\.empty"\)/, "nothing waiting has to look like an answer, not a failed load");
  // Severity is carried by a word as well as by colour.
  assert.match(command, /t\(`needs\.kind\.\$\{item\.kind\}`\)/);
  // Approvals stay decidable from the home.
  assert.match(command, /api\.pulse\.decideApproval/);
  // A page that polls must be able to stop, or the interval outlives the page.
  assert.match(command, /clearInterval\(cmdPoll\)/);
});

test("density is a preference that can finally be expressed", () => {
  // settings.compact has been in the store since the beginning and
  // body.compact has been in the stylesheet since the beginning. Nothing set
  // the one or read the other.
  assert.match(read("assets/js/store.js"), /compact: false/);
  assert.match(STYLES, /body\.compact \.view/);
  assert.match(APP, /const isCompact = \(\) => store\.state\.settings\.compact === true/);
  assert.match(APP, /document\.body\.classList\.toggle\("compact", isCompact\(\)\)/);
  assert.match(APP, /shell\.density/, "and it is reachable from the account menu");
  // Applied at boot, or the preference is forgotten on every reload — and
  // again after setScope, or a signed-in user gets whoever-was-here-last's.
  // Checked by position rather than adjacency: things legitimately get added
  // between these lines.
  const boot = APP.slice(APP.indexOf("async function boot()"));
  const firstApply = boot.indexOf("applyDensity();");
  assert.ok(firstApply !== -1 && firstApply < boot.indexOf("await api.detect()"),
    "density has to be applied before the app decides what to render");
  assert.ok(boot.indexOf("applyDensity();", boot.indexOf("store.setScope")) !== -1,
    "and again once this account's own settings are loaded");
});

test("the rail survives every breakpoint the shell has", () => {
  // Wide: rail plus section column. Narrow: rail, with the column as a flyout.
  // Phone: both, inside the drawer that already has the scrim and focus trap.
  // The base rule, not one of its overrides: both the wide layout and the
  // phone drawer declare two columns, so matching "somewhere in the file"
  // stays true even when the default has been flattened to one.
  const base = STYLES.slice(STYLES.indexOf("\n.sidebar {"));
  assert.match(base.slice(0, base.indexOf("}")),
    /grid-template-columns: var\(--rail-w\) minmax\(0, 1fr\);/,
    "the default sidebar is rail + section column");
  // Narrow: rail only, column as a flyout. Phone: both, inside the drawer.
  assert.match(STYLES, /@media \(max-width: 1280px\)[\s\S]*?\.sectionnav \{[\s\S]*?position: absolute;/);
  assert.match(STYLES, /@media \(max-width: 900px\)[\s\S]*?\.sectionnav \{[\s\S]*?position: static;/);
  assert.match(APP, /wireSectionFlyout\(sidebar\)/);
  // The drawer closes on a rail tap too, not only on a child tap.
  assert.match(APP, /qsa\("\.nav-item, \.rail-item"\)/);
});

test("a rail item is big enough to hit and says which one it is", () => {
  // [^}]* not [\s\S]*? — a lazy any-character match walks straight out of the
  // rule and finds the declaration in some other block, so the assertion holds
  // while the thing it names does not.
  assert.match(STYLES, /\.rail-item \{[^}]*min-height: 52px;/);
  // Icon plus label, not icon alone: an icon rail with no words is a memory test.
  assert.match(APP, /\$\{icon\(section\.icon\)\}<span>\$\{sectionLabel\(section\)\}<\/span>/);
  // The count badge is absent rather than zero.
  assert.match(STYLES, /\.rail-count\[hidden\] \{ display: none; \}/);
  assert.match(APP, /badge\.hidden = total === 0/);
});

test("relative time reads as the past, not as a negative number", () => {
  // Narrow style renders Russian as "-2 ч": a minus sign where "ago" belongs.
  const store = read("assets/js/store.js");
  assert.match(store, /style: "short"/);
  assert.doesNotMatch(store, /style: "narrow"/);
  const ru = new Intl.RelativeTimeFormat("ru-RU", { numeric: "auto", style: "short" });
  assert.equal(ru.format(-2, "hour"), "2 ч назад");
});

test("MILA stays findable by name, not only by knowing what the orb is", () => {
  // She is the orb rather than a rail section, which is the right call — an
  // assistant is not a destination you navigate to and leave. But the palette
  // walks section children, so making her an orb silently took her out of it:
  // typing "mila" found nothing, and the only way in was already knowing what
  // the gradient circle did. Reachable is not the same as findable, and the
  // person who noticed asked where she had gone.
  assert.match(APP, /if \(pages\(\)\.mila\) \{\s*\r?\n\s*cmds\.push\(\{[\s\S]{0,200}?hint: "#\/mila"/,
    "the command palette must offer Mila Live");
  // The orb carries her name for a pointer and for a screen reader; every
  // other rail control has a visible word beside it and this one cannot.
  assert.match(APP, /class="rail-orb tip" data-tip="\$\{tr\("nav\.mila"\)\}"/);
  assert.match(APP, /class="tab-orb" href="#\/mila" aria-label="\$\{tr\("nav\.mila"\)\}"/);
  // And the page itself is still routed for the roles that had it.
  assert.match(APP, /const OPERATOR_PAGES = \{[^}]*\bmila\b/);
  assert.match(APP, /const MEMBER_PAGES = \{[^}]*\bmila\b/);
  assert.match(APP, /if \(pages\(\)\.mila\) mountMilaDock\(\)/, "the live-call dock follows her");
});
