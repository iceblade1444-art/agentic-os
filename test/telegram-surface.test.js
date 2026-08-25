// The console behaving like a Mini App rather than like a web page Telegram
// happens to be showing.
//
// Measured inside a Telegram-sized viewport before any of this: the topbar and
// the tab bar took 124px of about 660 — a fifth of the screen — before a single
// row of content, and one of the four controls up there was a theme toggle
// fighting the palette the container had just handed the page.
//
// The gestures matter more than the pixels. A vertical swipe inside Telegram
// drags the sheet closed, and this page scrolls to roughly four screens, so a
// normal flick to read further could dismiss the app mid-sentence.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const BRIDGE = read("assets/js/telegram-miniapp.js");
const STYLES = read("assets/css/styles.css");
const I18N = read("assets/js/i18n.js");
const TELEGRAM = read("server/lib/telegram.js");

test("scrolling the page cannot close the app", () => {
  // The one that would be noticed as a bug rather than as roughness.
  assert.match(BRIDGE, /app\.disableVerticalSwipes\?\.\(\)/);
  // Optional-called, because it arrived in a later Bot API than the clients
  // this has to keep working on.
  assert.doesNotMatch(BRIDGE, /app\.disableVerticalSwipes\(\)/);
});

test("the header Telegram draws is the colour of the page under it", () => {
  assert.match(BRIDGE, /app\.setHeaderColor\?\.\(ground\)/);
  assert.match(BRIDGE, /const ground = app\.themeParams\?\.bg_color;/);
});

test("the hardware insets reach the layout that already knows what to do", () => {
  // Fed into the same --safe-* tokens the phone layout uses, rather than a
  // second mechanism that would have to be kept in step with the first.
  assert.match(BRIDGE, /const inset = app\.contentSafeAreaInset \|\| app\.safeAreaInset;/);
  assert.match(BRIDGE, /root\.style\.setProperty\(`--safe-\$\{side\}`/);
  assert.match(BRIDGE, /\[\["t", "top"\], \["r", "right"\], \["b", "bottom"\], \["l", "left"\]\]/);
});

test("an inset that changes mid-session is picked up", () => {
  // A phone rotating, or the keyboard opening, moves these.
  assert.match(BRIDGE, /onEvent\?\.\("safeAreaChanged"/);
  assert.match(BRIDGE, /onEvent\?\.\("contentSafeAreaChanged"/);
});

test("the container chrome is applied on mount, not only on change", () => {
  const mount = BRIDGE.slice(BRIDGE.indexOf("export function mountTelegramBridge"));
  assert.match(mount, /applyContainerChrome\(app\);/);
});

test("the theme toggle is gone where the theme is not ours", () => {
  // Telegram hands the app its palette. A toggle here puts the page in a scheme
  // the chat around it does not share.
  assert.match(STYLES, /\[data-surface="telegram"\] #themeBtn \{ display: none; \}/);
});

test("the second header is shorter than a first one", () => {
  assert.match(STYLES, /\[data-surface="telegram"\] \.topbar \{[^}]*height: 48px;/);
});

test("the tab bar sits above the home indicator rather than under it", () => {
  const rule = STYLES.slice(STYLES.indexOf('[data-surface="telegram"] .tabbar'));
  assert.match(rule.slice(0, rule.indexOf("}")), /height: calc\(52px \+ var\(--safe-b\)\)/);
  assert.match(rule.slice(0, rule.indexOf("}")), /padding-bottom: var\(--safe-b\)/);
});

test("the menu button is a name, not a sentence", () => {
  // Telegram gives it a fixed strip beside the message field, and the verb was
  // pushing the field into a sliver on a phone.
  const values = [...I18N.matchAll(/"telegram\.menuButton": "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(values.length, 3, "one per locale");
  for (const value of values) {
    assert.equal(value, "Agentic OS", "the button carries the product name and nothing else");
  }
});

test("the menu button being one word in three languages is on purpose", () => {
  // It is published once rather than per language, unlike setMyCommands, which
  // used to mean an English chat got the Russian wording. A product name is the
  // same in all three, so that stops mattering — but the reason is written down
  // so nobody re-localises it and reintroduces the bug.
  assert.match(TELEGRAM, /published once rather than per language/);
  assert.match(TELEGRAM, /tIn\("ru-RU", "telegram\.menuButton"\)/);
});

test("nothing was hidden that cannot be reached another way", () => {
  // The drawer still opens the whole of navigation and search still opens the
  // palette; only the theme toggle is gone, and its job belongs to Telegram.
  const hidden = [...STYLES.matchAll(/\[data-surface="telegram"\][^{]*\{\s*display: none;/g)]
    .map((m) => m[0]);
  assert.equal(hidden.length, 1, `more than the theme toggle is hidden: ${hidden.join(" | ")}`);
  assert.match(hidden[0], /#themeBtn/);
});
