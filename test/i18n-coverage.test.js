// The interface is used in Russian. A page that renders English literals is not
// a cosmetic problem — the sidebar entry is translated, so the person clicks a
// Russian word and lands somewhere they cannot read.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SUPPORTED_LOCALES, setLocale, t } from "../assets/js/i18n.js";

const pagesDir = fileURLToPath(new URL("../assets/js/pages/", import.meta.url));
const pages = fs.readdirSync(pagesDir).filter((name) => name.endsWith(".js"));

// Still English, and known to be. Shrink this list; never grow it. Each entry
// costs a Russian-speaking operator a page they cannot read, so leaving one here
// is a decision to postpone, not a decision to skip.
const NOT_TRANSLATED_YET = new Set([
  "claude-code.js", "components.js", "missions.js", "speech.js",
]);

test("no page quietly falls out of translation", () => {
  const untranslated = pages.filter((name) => {
    const source = fs.readFileSync(path.join(pagesDir, name), "utf8");
    return !/\bt\(\s*"/.test(source);
  });
  for (const name of untranslated) {
    assert.ok(
      NOT_TRANSLATED_YET.has(name),
      `${name} renders English literals and is not on the known list — add the t() calls, `
      + "or add it to NOT_TRANSLATED_YET with a reason",
    );
  }
  // And the list cannot outlive the work: once a page is translated it has to
  // leave, or the guard stops meaning anything.
  for (const name of NOT_TRANSLATED_YET) {
    assert.ok(untranslated.includes(name), `${name} is translated now — take it off NOT_TRANSLATED_YET`);
  }
});

test("every key the interface asks for exists in every language", () => {
  const used = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const source = fs.readFileSync(full, "utf8");
      for (const match of source.matchAll(/\bt\(\s*"([a-zA-Z0-9_.-]+)"/g)) used.add(match[1]);
    }
  };
  walk(fileURLToPath(new URL("../assets/js/", import.meta.url)));
  assert.ok(used.size > 200, `the extraction must still be finding keys, got ${used.size}`);

  const missing = [];
  for (const [locale] of SUPPORTED_LOCALES) {
    setLocale(locale, false);
    // t() falls back to en-US and then to the key itself, so a key that comes
    // back unchanged is one nobody ever wrote a translation for.
    for (const key of used) if (t(key) === key) missing.push(`${locale} → ${key}`);
  }
  assert.deepEqual(missing, [], "these keys render as their own name");
});

test("a translation never loses a placeholder", () => {
  // {count} left out of one language is a sentence that silently drops a number.
  const byKey = new Map();
  for (const [locale] of SUPPORTED_LOCALES) {
    setLocale(locale, false);
    for (const key of collectKeys()) {
      const holders = [...t(key).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      if (!byKey.has(key)) byKey.set(key, new Map());
      byKey.get(key).set(locale, holders.join(","));
    }
  }
  const mismatched = [...byKey.entries()]
    .filter(([, perLocale]) => new Set(perLocale.values()).size > 1)
    .map(([key, perLocale]) => `${key}: ${[...perLocale].map(([l, h]) => `${l}=[${h}]`).join(" ")}`);
  assert.deepEqual(mismatched, []);
});

function collectKeys() {
  const source = fs.readFileSync(fileURLToPath(new URL("../assets/js/i18n.js", import.meta.url)), "utf8");
  return new Set([...source.matchAll(/"([a-z][a-zA-Z0-9_.-]*\.[a-zA-Z0-9_.-]+)":/g)].map((match) => match[1]));
}
