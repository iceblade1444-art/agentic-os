// One palette, two runtimes.
//
// The Flutter app and the web app were designed independently and reconciled
// never: not one colour matched. Different violet, different background,
// different surface, different success, different danger, 14px base against
// 16px, self-hosted fonts against a CDN. A person who used both was using two
// products that happened to share a name.
//
// tokens.css is the source. This reads it and emits two things:
//
//   assets/design-tokens.json   the machine-readable palette, committed, and
//                               checked against tokens.css by a test
//   (--dart <path>)             MilaColors for the Flutter app, generated
//
// Run: node scripts/export-design-tokens.mjs [--dart <path/to/mila_tokens.dart>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const uncomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

export function parseThemes(css) {
  const src = uncomment(css);
  const themes = { dark: {}, light: {} };
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(src))) {
    const selectors = match[1].split(",").map((s) => s.trim());
    const decls = [...match[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)];
    for (const name of ["dark", "light"]) {
      const applies = selectors.includes(":root") || selectors.includes(`:root[data-theme="${name}"]`);
      if (!applies) continue;
      for (const [, key, value] of decls) themes[name][key] = value.trim();
    }
  }
  return themes;
}

// `--primary: var(--violet-600)` has to become a colour before Dart can hold it.
export function resolve(tokens, name, depth = 0) {
  const value = tokens[name];
  if (value === undefined) throw new Error(`undefined token ${name}`);
  if (depth > 8) throw new Error(`token ${name} references itself`);
  const ref = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value);
  return ref ? resolve(tokens, ref[1], depth + 1) : value;
}

// What the phone needs. Deliberately a short list: the app does not have
// forty surfaces, and every entry here is one more thing that can drift.
export const SHARED = [
  "--bg", "--bg-1", "--surface", "--surface-2", "--surface-3",
  "--border", "--border-strong", "--border-interactive",
  "--text", "--text-2", "--text-3",
  "--primary", "--primary-hover", "--primary-ink",
  "--success", "--success-ink", "--warning", "--warning-ink",
  "--error", "--error-ink", "--danger-fill", "--info", "--info-ink",
  "--teal", "--teal-ink",
];

export function exportTokens(css) {
  const themes = parseThemes(css);
  const out = { note: "Generated from assets/css/tokens.css by scripts/export-design-tokens.mjs. Do not edit.", dark: {}, light: {} };
  for (const theme of ["dark", "light"]) {
    for (const token of SHARED) {
      const value = resolve(themes[theme], token);
      if (!/^#[0-9a-f]{3,8}$/i.test(value)) throw new Error(`${token} in ${theme} is not a hex colour: ${value}`);
      out[theme][token] = value.toLowerCase();
    }
  }
  return out;
}

const dartName = (token) => token
  .replace(/^--/, "")
  .replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

const argb = (hex) => {
  const raw = hex.replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  return `0xFF${full.toUpperCase()}`;
};

export function toDart(tokens) {
  const block = (theme) => SHARED
    .map((token) => `  static const ${dartName(token)} = Color(${argb(tokens[theme][token])});`)
    .join("\n");
  return `// GENERATED — do not edit.
//
// Source: agentic-os/assets/css/tokens.css
// Regenerate: node scripts/export-design-tokens.mjs --dart <path>
//
// The web console and this app used to carry two unrelated palettes. They are
// one palette now, and this file is the copy the phone reads.

import 'dart:ui' show Color;

/// Dark is the product's default and the only theme the app ships today; the
/// light values are here so adding it later is a switch, not a redesign.
abstract final class MilaTokensDark {
${block("dark")}
}

abstract final class MilaTokensLight {
${block("light")}
}
`;
}

// pathToFileURL, not string surgery: on Windows a drive path becomes
// file:///C:/… with three slashes, and a hand-built file://C:/… never matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const css = fs.readFileSync(path.join(root, "assets/css/tokens.css"), "utf8");
  const tokens = exportTokens(css);
  const jsonPath = path.join(root, "assets/design-tokens.json");
  fs.writeFileSync(jsonPath, `${JSON.stringify(tokens, null, 2)}\n`);
  console.log(`wrote ${path.relative(root, jsonPath)} (${SHARED.length} tokens × 2 themes)`);

  const dartAt = process.argv.indexOf("--dart");
  if (dartAt !== -1 && process.argv[dartAt + 1]) {
    const target = process.argv[dartAt + 1];
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, toDart(tokens));
    console.log(`wrote ${target}`);
  }
}
