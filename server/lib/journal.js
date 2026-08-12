// The day journal: what the system actually did, written where agents can read it.
//
// Knowledge used to flow one way — the playbook and workspace facts went down into
// every agent, and nothing came back. So MILA could plan a morning, create a task,
// move a meeting, and by the next call none of it had happened as far as she knew.
// `agentos-runtime/memory/index.json` even declares a policy to update memory after
// a successful run; no code implemented it and nothing reads those files.
//
// This closes the loop. Every state-changing action appends one line to
// `Agentic OS/Journal/YYYY-MM-DD.md` in the vault, and `sharedAgentContext` feeds
// the last few days back into whatever agent asks for context. The vault is the
// store on purpose: the team already reads and edits it by hand in Obsidian.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import { planningInternals } from "./personal-planner.js";

export const JOURNAL_FOLDER = "Agentic OS/Journal";
const MAX_ENTRY_CHARS = 300;
const MAX_ENTRIES_PER_DAY = 200;
const CACHE_MS = 30 * 1000;

const clean = (value, max = MAX_ENTRY_CHARS) => String(value ?? "")
  .replace(/[\r\n]+/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

// A journal line is read by both a person in Obsidian and a model in a prompt, so
// it stays one plain sentence with a timestamp and an actor — no JSON, no markdown
// beyond the bullet.
function formatEntry({ time, actor, kind, title, detail }) {
  const parts = [`- ${time}`, actor ? `**${actor}**` : "", kind ? `(${kind})` : "", clean(title)];
  const head = parts.filter(Boolean).join(" ");
  const tail = clean(detail, 200);
  return tail ? `${head} — ${tail}` : head;
}

export function createJournal(options = {}) {
  const vaultDir = path.resolve(options.vaultDir || config.obsidianVault);
  const now = options.now || (() => new Date());
  let cache = null;

  const fileFor = (dateKey) => path.join(vaultDir, JOURNAL_FOLDER, `${dateKey}.md`);

  function dateKeyFor(timeZone, at) {
    try {
      return planningInternals.localDateKey(at, timeZone || "Asia/Tashkent");
    } catch {
      return at.toISOString().slice(0, 10);
    }
  }

  /// Appends one line for today. Best-effort by design: journalling must never be
  /// the reason an action the user asked for reports a failure.
  async function append(entry = {}) {
    try {
      const at = entry.at ? new Date(entry.at) : now();
      const timeZone = entry.timezone || "Asia/Tashkent";
      const dateKey = dateKeyFor(timeZone, at);
      const file = fileFor(dateKey);
      const line = formatEntry({
        time: planningInternals.localTimeLabel(at, timeZone),
        actor: clean(entry.actor, 60),
        kind: clean(entry.kind, 40),
        title: entry.title,
        detail: entry.detail,
      });
      if (!clean(entry.title)) return null;

      await fsp.mkdir(path.dirname(file), { recursive: true });
      let existing = "";
      try { existing = await fsp.readFile(file, "utf8"); } catch { /* first entry today */ }
      if (!existing) {
        existing = `# ${dateKey}\n\nWhat Agentic OS did on this day. Written automatically; safe to edit or annotate by hand.\n\n`;
      }
      // A runaway loop must not grow the file without bound.
      if ((existing.match(/^- /gm) || []).length >= MAX_ENTRIES_PER_DAY) return null;
      await fsp.writeFile(file, `${existing.replace(/\s*$/, "")}\n${line}\n`, "utf8");
      cache = null;
      return { dateKey, line };
    } catch (error) {
      console.error(`[journal] could not record an entry: ${error.message}`);
      return null;
    }
  }

  /// The last `days` journals as plain text, newest day last, trimmed to `budget`.
  /// Synchronous because `sharedAgentContext` is, and the vault is local disk.
  function recentText({ days = 3, budget = 1800, timeZone = "Asia/Tashkent" } = {}) {
    const stamp = Date.now();
    if (cache && cache.budget === budget && cache.days === days && stamp - cache.at < CACHE_MS) {
      return cache.text;
    }
    const keys = [];
    for (let back = days - 1; back >= 0; back -= 1) {
      keys.push(dateKeyFor(timeZone, new Date(now().getTime() - back * 24 * 60 * 60 * 1000)));
    }
    const blocks = [];
    for (const key of keys) {
      try {
        const body = fs.readFileSync(fileFor(key), "utf8");
        const lines = body.split("\n").filter((line) => line.startsWith("- "));
        if (lines.length) blocks.push(`${key}:\n${lines.join("\n")}`);
      } catch { /* no journal that day */ }
    }
    // Oldest lines are the ones to lose when the budget is tight.
    let text = blocks.join("\n\n");
    while (text.length > budget && blocks.length) {
      blocks.shift();
      text = blocks.join("\n\n");
    }
    if (text.length > budget) text = text.slice(-budget);
    cache = { at: stamp, budget, days, text };
    return text;
  }

  function readDay(dateKey) {
    try {
      return fs.readFileSync(fileFor(String(dateKey || "").slice(0, 10)), "utf8");
    } catch {
      return "";
    }
  }

  function listDays(limit = 14) {
    try {
      return fs.readdirSync(path.join(vaultDir, JOURNAL_FOLDER))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
        .map((name) => name.replace(/\.md$/, ""))
        .sort()
        .reverse()
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  return { append, recentText, readDay, listDays, invalidate: () => { cache = null; }, fileFor };
}

export const journal = createJournal();
