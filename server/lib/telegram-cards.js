// What a notification looks like when it arrives in Telegram, and what a person
// can do about it without leaving the chat.
//
// Before this, every notification — a reminder, the morning brief, a colleague's
// message, an ERP anomaly — arrived as the same unformatted blob of text with
// exactly one button on it: "Озвучить". Nothing could be completed, snoozed or
// opened. For most of the 1500 people at the factory Telegram is not a channel
// the product notifies through, it is the product, and it offered them one verb.
//
// Everything here is a pure function of the item and the reader's locale. The
// bridge does the I/O; this module decides what the message says, which buttons
// it carries, and how a button press is encoded into the 64 bytes Telegram
// allows. That split is what makes the wording testable without a bot token.

import { tIn } from "../../assets/js/i18n.js";

// Telegram's HTML parse mode. Only these three characters need escaping, and
// they must be escaped or a task titled "<Ташкент> & Co" silently breaks the
// whole message — Telegram rejects it and the notification is simply not sent.
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// One card type per kind of thing that can arrive. `type` is what a real inbox
// item carries; `kind` is what the ad-hoc senders (ERP, leads, the evening
// summary) pass instead. Both are read, because both exist in the wild.
//
// The emoji is a prefix on the title, never the only signal: the label word is
// always present too, so the card still reads on a client that cannot show it
// and for anyone who does not parse colour or pictograms.
const CARDS = {
  reminder: { icon: "⏰", label: "telegram.card.reminder", actions: ["done", "snooze"] },
  task: { icon: "✅", label: "telegram.card.task", actions: ["done", "open"] },
  calendar: { icon: "📅", label: "telegram.card.calendar", actions: ["ack", "open"] },
  "event-alert": { icon: "📅", label: "telegram.card.calendar", actions: ["ack"] },
  message: { icon: "💬", label: "telegram.card.message", actions: ["ack", "open"] },
  agent_result: { icon: "🤖", label: "telegram.card.agent", actions: ["ack", "open"] },
  "erp-anomaly": { icon: "⚠️", label: "telegram.card.erp", actions: ["ack", "open"] },
  "erp-weekly": { icon: "📊", label: "telegram.card.erpWeek", actions: ["ack", "open"] },
  "evening-summary": { icon: "🌙", label: "telegram.card.evening", actions: ["ack"] },
  brief: { icon: "☀️", label: "telegram.card.brief", actions: ["ack", "open"] },
  lead: { icon: "🎯", label: "telegram.card.lead", actions: ["ack", "open"] },
  system: { icon: "🔔", label: "telegram.card.notice", actions: ["ack"] },
};

export const CARD_TYPES = Object.keys(CARDS);

// The morning brief arrives as a plain item with speak:true and a title the
// planner wrote; nothing on it says "brief". This is the one card recognised by
// behaviour rather than by a field, and it is worth the special case because it
// is the message most people read every day.
export function cardKindOf(item = {}) {
  if (item.speak === true) return "brief";
  const named = item.type || item.kind;
  return Object.hasOwn(CARDS, named) ? named : "system";
}

/* ---------------- callback payloads ----------------

   Telegram caps callback_data at 64 bytes. That is not enough to carry a
   notification, so it carries a verb and an id and nothing else; the chat
   itself identifies the person, and the item is looked up on arrival.

   The leading "1" is a format version. When the shape has to change, old
   buttons still sitting in people's chat history decode as unknown rather than
   as the wrong action. */

export const CALLBACK_LIMIT = 64;
const SEP = "|";

export function encodeCallback(action, id, arg = "") {
  const payload = ["1", action, arg, String(id ?? "")].filter((part, index) => index !== 2 || arg !== "").join(SEP);
  // A caller that would exceed the budget gets null and drops the button. A
  // truncated id would decode into a lookup for something that does not exist,
  // which is worse than an absent button: the person taps and nothing happens.
  return Buffer.byteLength(payload, "utf8") <= CALLBACK_LIMIT ? payload : null;
}

export function parseCallback(data) {
  const parts = String(data ?? "").split(SEP);
  if (parts[0] !== "1" || parts.length < 3) return null;
  const [, action, ...rest] = parts;
  // snooze is the only verb carrying an argument, so a four-part payload is a
  // snooze and a three-part payload is not.
  if (rest.length > 1) return { action, arg: rest[0], id: rest.slice(1).join(SEP) };
  return { action, arg: "", id: rest[0] };
}

/* ---------------- the card ---------------- */

const SNOOZE_MINUTES = 60;

// Where "Open" goes. The SPA reads ?start=<route> and turns it into a hash
// route; index.html has handled that since the Telegram links first existed.
function openUrl(publicUrl, route) {
  const base = String(publicUrl || "").replace(/\/+$/, "");
  if (!base || !route) return "";
  const clean = String(route).replace(/^#?\/*/, "").replace(/[^a-z0-9/-]/gi, "");
  return clean ? `${base}/?start=${clean}` : "";
}

/**
 * Compose one notification.
 *
 * Returns the message text in Telegram HTML plus the inline keyboard, or null
 * for an item with nothing in it. The caller supplies locale and publicUrl so
 * this module stays free of config and of the current-locale global.
 */
export function buildCard(item = {}, options = {}) {
  const locale = options.locale || "ru-RU";
  const kind = cardKindOf(item);
  const card = CARDS[kind];
  const T = (key, values) => tIn(locale, key, values);

  const title = String(item.title ?? "").trim();
  const body = String(item.body ?? "").trim();
  if (!title && !body) return null;

  // Title in bold behind its icon and label; body as plain text under it. The
  // label is dropped when the title already opens with it, which the ERP and
  // brief titles tend to do.
  const label = T(card.label);
  const heading = title || label;
  const lines = [`${card.icon} <b>${escapeHtml(heading)}</b>`];
  if (body) lines.push("", escapeHtml(body));

  const rows = [];
  const primary = [];
  for (const action of card.actions) {
    if (action === "open") {
      const url = openUrl(options.publicUrl, item.route);
      if (url) primary.push({ text: T("telegram.act.open"), url });
      continue;
    }
    if (action === "snooze") {
      const hour = encodeCallback("s", item.id, String(SNOOZE_MINUTES));
      const evening = encodeCallback("s", item.id, "evening");
      if (hour) primary.push({ text: T("telegram.act.hour"), callback_data: hour });
      if (evening) primary.push({ text: T("telegram.act.evening"), callback_data: evening });
      continue;
    }
    const verb = action === "done" ? "d" : "a";
    const data = encodeCallback(verb, item.id);
    if (data) {
      primary.unshift({
        text: T(action === "done" ? "telegram.act.done" : "telegram.act.ack"),
        callback_data: data,
      });
    }
  }
  if (primary.length) rows.push(primary);

  // Listening stays on every card. It is the one affordance this bot already
  // had, people use it walking the factory floor, and it needs no payload —
  // Telegram hands the original message back with the press.
  rows.push([{ text: `🔊 ${T("telegram.act.listen")}`, callback_data: "speak" }]);

  return {
    text: lines.join("\n"),
    parseMode: "HTML",
    keyboard: { inline_keyboard: rows },
    kind,
  };
}

/** The "/" menu Telegram shows, in the language of whoever is reading it. */
export function commandList(locale = "ru-RU") {
  return [
    ["today", "telegram.cmd.today"],
    ["tasks", "telegram.cmd.tasks"],
    ["erp", "telegram.cmd.erp"],
    ["ask", "telegram.cmd.ask"],
    ["help", "telegram.cmd.help"],
    ["stop", "telegram.cmd.stop"],
  ].map(([command, key]) => ({ command, description: tIn(locale, key) }));
}

/** Commands that are answered by putting a question to MILA. */
export const ASSISTANT_COMMANDS = {
  today: "telegram.ask.today",
  tasks: "telegram.ask.tasks",
  erp: "telegram.ask.erp",
};

export const cardInternals = { CARDS, SNOOZE_MINUTES, openUrl };
