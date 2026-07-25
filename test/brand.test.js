import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("brand assets are self-hosted vector files with a themeable mark", () => {
  const mark = read("assets/brand/mila-mark.svg");
  const lockup = read("assets/brand/mila-lockup.svg");
  const favicon = read("assets/brand/favicon.svg");

  for (const [name, svg] of [["mark", mark], ["lockup", lockup], ["favicon", favicon]]) {
    assert.match(svg, /^<svg [^>]*viewBox="0 0 [\d.]+ [\d.]+"/, `${name} needs a viewBox so it scales`);
    assert.doesNotMatch(svg, /<image|xlink:href/, `${name} must stay vector, not an embedded raster`);
  }
  // The mark and lockup tint with the surrounding ink; the favicon is fixed brand violet.
  assert.match(mark, /fill="currentColor"/);
  assert.match(lockup, /fill="currentColor"/);
  assert.match(favicon, /#7c3aed/);
});

test("the app shell uses the Mila logo everywhere the old placeholder sat", () => {
  const html = read("index.html");
  const app = read("assets/js/app.js");
  const onboarding = read("assets/js/onboarding.js");
  const css = read("assets/css/styles.css");
  const brand = read("assets/js/brand.js");

  assert.match(brand, /export function brandMark/);
  assert.match(html, /rel="icon" href="\.\/assets\/brand\/favicon\.svg"/);
  // No leftover inline placeholder favicon or rocket-as-logo.
  assert.doesNotMatch(html, /data:image\/svg\+xml/);
  assert.doesNotMatch(app, /brand-mark">\$\{icon\("rocket"\)\}/);
  assert.doesNotMatch(onboarding, /onboarding-brand"><span>\$\{icon\("rocket"\)\}/);

  assert.match(app, /brand-lockup/);
  assert.match(app, /brandMark\(\)/);
  assert.match(onboarding, /brandMark\(\)/);
  // Sidebar lockup and boot mark are masked from the shared SVG files.
  assert.match(css, /mask: url\("\.\.\/brand\/mila-lockup\.svg"\)/);
  assert.match(css, /mask: url\("\.\.\/brand\/mila-mark\.svg"\)/);
});
