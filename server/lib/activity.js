// What MILA did, per person, so the phone can answer "what happened while I
// was in the workshop".
//
// The obvious store for this already exists and cannot be used. The day journal
// (`vault/Agentic OS/Journal/<date>.md`) records every state-changing action —
// but it is one file a day for the whole company, read by Creator, Admin and
// Design alike, which is why its personal lines deliberately record that
// something happened and never what it was. A feed built from it would either
// publish other people's work or say "задача создана" without saying which.
//
// So this is a per-user store, and its privacy argument is narrow on purpose:
// it records only items that were already delivered to that same person through
// their own notification channel. `pushService.sendInbox(userId, item)` is the
// single door every notification leaves through — reminders, the morning brief,
// calendar alerts, messenger pushes, ERP anomalies — and it already takes the
// user as its first argument. Appending there adds no new audience. Nothing
// reaches this store that had not already reached that phone.
//
// Per the account-deletion rule, this store has removeUser and a line in
// account-lifecycle.js. A store without both leaves data behind forever.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";

// Enough to scroll a few days without turning the file into a log. The feed is
// for catching up, not for auditing — the journal is the audit trail.
const MAX_PER_USER = 120;

const clean = (value, max) => String(value ?? "").trim().slice(0, max);
const now = () => new Date().toISOString();

function emptyState() {
  return { version: 1, entries: [] };
}

/** The kinds the notification vocabulary already uses, plus a fallback. */
export const ACTIVITY_KINDS = [
  "reminder", "task", "calendar", "message", "brief", "lead", "erp", "system",
];

export function publicEntry(entry = {}) {
  const kind = ACTIVITY_KINDS.includes(entry.kind) ? entry.kind : "system";
  return {
    id: clean(entry.id, 120) || `act_${crypto.randomUUID()}`,
    userId: clean(entry.userId, 120),
    kind,
    title: clean(entry.title, 200),
    detail: clean(entry.detail, 400),
    // Where to go when the row is tapped. A route, never a payload — the phone
    // asks for the thing itself, so a stale feed cannot serve stale content.
    route: clean(entry.route, 200),
    at: clean(entry.at, 40) || now(),
  };
}

/**
 * Turn a delivered notification into a feed entry. Titles come from the item
 * that was already sent, so this cannot widen what the person can see.
 */
export function entryFromItem(userId, item = {}, kindOf) {
  const kind = typeof kindOf === "function" ? kindOf(item) : (item.type || item.kind);
  return publicEntry({
    userId,
    kind,
    title: item.title || item.subject || item.text || "",
    detail: item.body || item.detail || item.summary || "",
    route: item.route || item.deepLink || "",
    at: item.at || item.createdAt || now(),
  });
}

export class ActivityStore {
  constructor(file = path.join(path.resolve(config.dataDir), "activity.json")) {
    this.file = file;
    this.state = this.#read();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!parsed || !Array.isArray(parsed.entries)) return emptyState();
      return { version: 1, entries: parsed.entries.map(publicEntry) };
    } catch {
      return emptyState();
    }
  }

  #write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    hardenRuntimeFile(this.file);
  }

  /** Newest first, this user only. */
  list(userId, { limit = 40 } = {}) {
    const id = clean(userId, 120);
    if (!id) return [];
    return this.state.entries
      .filter((entry) => entry.userId === id)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, Math.max(1, Math.min(limit, MAX_PER_USER)));
  }

  append(userId, entry) {
    const id = clean(userId, 120);
    if (!id) return null;
    const record = publicEntry({ ...entry, userId: id });
    // An entry with nothing to read is noise in a feed whose whole job is to be
    // read at a glance.
    if (!record.title) return null;

    this.state.entries.push(record);
    // Trim this user's tail only. One busy account must not evict another's.
    const mine = this.state.entries.filter((e) => e.userId === id);
    if (mine.length > MAX_PER_USER) {
      const keep = new Set(
        mine.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, MAX_PER_USER).map((e) => e.id),
      );
      this.state.entries = this.state.entries.filter((e) => e.userId !== id || keep.has(e.id));
    }
    this.#write();
    return record;
  }

  removeUser(userId) {
    const id = clean(userId, 120);
    if (!id) return 0;
    const before = this.state.entries.length;
    this.state.entries = this.state.entries.filter((entry) => entry.userId !== id);
    const removed = before - this.state.entries.length;
    if (removed) this.#write();
    return removed;
  }
}

export const activity = new ActivityStore();
