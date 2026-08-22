#!/usr/bin/env node
// Refuse a change that reaches production without moving the version.
//
// The sibling repository learned this the hard way: a UI redesign merged with
// pubspec still naming the version already registered on the backend, and
// every phone answered "up to date" for days — correctly. Here the failure is
// quieter, because a browser reloads and gets whatever is on the server. What
// was missing is the other half: no way to ask a running deployment which
// change it is running. /api/health answered "1.0.0" for the life of the
// repository, so confirming a deploy meant grepping the served CSS for a
// string only the person who wrote it would know to look for.
//
// So the version here is a release marker rather than an update trigger, and
// this keeps it honest: if what production serves changed, the number it
// reports has to change with it.
//
// Usage:  node scripts/check-version-bump.mjs <base-ref> [head-ref]

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// What ends up in the deployed image or in a browser. Tests, docs, CI config
// and operator tooling are deliberately absent: none of them change what the
// product serves, and demanding a version for them would teach everyone to
// bump without meaning it — which is the same failure wearing a different hat.
export const SHIPPING = [
  "server/",
  "assets/",
  "index.html",
  "agentos-runtime/",
  "speech-service/",
  "speech-bot/",
  "package.json",
  "package-lock.json",
  "Dockerfile",
  "docker-compose.yml",
];

export const shippingChanges = (files) =>
  files.filter((f) => f && SHIPPING.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));

// Semver enough for this repository: three dot-separated numbers, compared
// left to right. A trailing pre-release tag is ignored rather than guessed at.
export function parseVersion(text) {
  const m = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** Pure verdict, so the interesting cases can be tested without a git repo. */
export function verdict({ files, baseVersion, headVersion }) {
  const shipping = shippingChanges(files);
  if (shipping.length === 0) {
    return { ok: true, reason: "no-shipping-changes", shipping };
  }
  if (!parseVersion(headVersion)) {
    return { ok: false, reason: "unreadable-head-version", shipping, baseVersion, headVersion };
  }
  if (!parseVersion(baseVersion)) {
    // Nothing to compare against — a new repository, or the field was only
    // just introduced. Allowing is the honest answer; failing would be noise.
    return { ok: true, reason: "no-base-version", shipping };
  }
  const cmp = compareVersions(baseVersion, headVersion);
  if (cmp === -1) return { ok: true, reason: "bumped", shipping, baseVersion, headVersion };
  return {
    ok: false,
    reason: cmp === 0 ? "unchanged" : "went-backwards",
    shipping, baseVersion, headVersion,
  };
}

export function explain(v) {
  if (v.ok) {
    if (v.reason === "no-shipping-changes") return "Nothing that reaches production changed — no version bump needed.";
    if (v.reason === "no-base-version") return "No readable version on the base — nothing to compare against, allowing.";
    return `Version moves ${v.baseVersion} -> ${v.headVersion} for ${v.shipping.length} shipping file(s).`;
  }
  const lines = [];
  if (v.reason === "unreadable-head-version") {
    lines.push(`package.json has no readable "version" here (found ${JSON.stringify(v.headVersion)}).`);
  } else {
    lines.push("This change reaches production but the version does not move.");
    lines.push("");
    lines.push(`  version on the base:  ${v.baseVersion}`);
    lines.push(`  version here:         ${v.headVersion}`);
  }
  lines.push("");
  lines.push("Files that end up in the image or in a browser:");
  for (const f of v.shipping.slice(0, 25)) lines.push(`  ${f}`);
  if (v.shipping.length > 25) lines.push(`  … and ${v.shipping.length - 25} more`);
  lines.push("");
  if (v.reason === "went-backwards") {
    lines.push("The version went backwards. /api/health would report a release older");
    lines.push("than one already deployed, which is worse than reporting nothing.");
  } else if (v.reason === "unchanged") {
    lines.push("/api/health reports this number, and it is the only way to ask a");
    lines.push("running deployment which change it is serving. Leave it where it is");
    lines.push("and the answer after this deploy is the same as the answer before it.");
  }
  lines.push("");
  lines.push('Raise "version" in package.json as part of this change.');
  return lines.join("\n");
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

function versionAt(ref) {
  try {
    return JSON.parse(git("show", `${ref}:package.json`)).version ?? null;
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const base = process.argv[2];
  const head = process.argv[3] || "HEAD";
  if (!base) {
    console.error("usage: node scripts/check-version-bump.mjs <base-ref> [head-ref]");
    process.exit(2);
  }
  const files = git("diff", "--name-only", `${base}...${head}`).split("\n").map((s) => s.trim());
  const v = verdict({ files, baseVersion: versionAt(base), headVersion: versionAt(head) });
  (v.ok ? console.log : console.error)(explain(v));
  process.exit(v.ok ? 0 : 1);
}
