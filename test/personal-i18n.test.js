import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { SUPPORTED_LOCALES, setLocale, t } from "../assets/js/i18n.js";

// Every t("...") the Personal page can render, pulled from the source so a new
// panel cannot ship with an untranslated label. A missing key renders as the raw
// key on screen, which is the failure this catches.
function keysUsedBy(file) {
  const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  const keys = new Set();
  for (const match of source.matchAll(/\bt\(\s*"([a-zA-Z][\w.]*)"/g)) keys.add(match[1]);
  return [...keys];
}

test("the Personal page is fully translated in every supported locale", () => {
  const keys = keysUsedBy("../assets/js/pages/personal.js");
  assert.ok(keys.length > 60, `expected the page to use many keys, found ${keys.length}`);

  const missing = [];
  for (const [locale] of SUPPORTED_LOCALES) {
    setLocale(locale);
    for (const key of keys) {
      // t() falls back to the key itself when nothing is defined anywhere.
      if (t(key) === key) missing.push(`${locale}: ${key}`);
    }
  }
  setLocale("ru-RU");
  assert.deepEqual(missing, [], `untranslated Personal page keys:\n${missing.join("\n")}`);
});

test("day-plan and reminder copy carries its placeholders through every locale", () => {
  const cases = [
    ["personal.plan.meetings", { count: 3 }, "3"],
    ["personal.plan.focusCount", { count: 2 }, "2"],
    ["personal.plan.free", { minutes: 90 }, "90"],
    ["personal.plan.unplaced", { count: 4 }, "4"],
  ];
  for (const [locale] of SUPPORTED_LOCALES) {
    setLocale(locale);
    for (const [key, values, expected] of cases) {
      const rendered = t(key, values);
      assert.ok(rendered.includes(expected), `${locale} ${key} lost its value: ${rendered}`);
      assert.doesNotMatch(rendered, /\{\w+\}/, `${locale} ${key} left a placeholder unfilled: ${rendered}`);
    }
  }
  setLocale("ru-RU");
});
