// Who may call what, per person and per channel — in one place.
//
// The audience gates in mila-actions.js answer "may this person call this at
// all". This module answers the second half: "and does this channel carry it".
// They are different questions. A Creator may call ask_claude_code, but a chat
// message must not be able to start a shell on the host; a Member may read the
// sewing report on every surface they have.
//
// The rule, once: the browser is the full surface for an operator, and every
// other channel carries the personal desk, company knowledge, the ERP reads
// everyone may see, and — for an operator — the staff and order reads. Nothing
// that reaches the host, the vault or another person's work travels through a
// chat window or a phone.
//
// This exists because four surfaces each kept their own copy of that sentence
// and the copies drifted: the calendar writes the browser gave a Member never
// reached Telegram, and the turnstile tools reached Telegram before the phone.

import { MILA_MEMBER_TOOLS, MILA_TOOLS } from "../../assets/js/mila-tools.js";
import {
  KNOWLEDGE_ACTIONS,
  OPERATOR_ERP_ACTIONS,
  PERSONAL_ACTIONS,
  READ_ONLY_ERP_ACTIONS,
} from "./mila-actions.js";

export const OPERATOR_ROLES = ["Creator", "Admin", "CEO"];
export const isOperator = (user) => OPERATOR_ROLES.includes(user?.role);

// Channels that carry the gated set rather than the full operator surface.
// "app" is the browser, where an operator is at their own desk with the
// confirmation UI in front of them.
const PER_CHANNEL_EXCLUSIONS = {
  // send_telegram exists to reach this chat from elsewhere; inside it, an echo.
  telegram: new Set(["send_telegram"]),
  mobile: new Set(),
  messenger: new Set(),
  app: new Set(),
};

function gatedNames(user) {
  const names = [...PERSONAL_ACTIONS, ...KNOWLEDGE_ACTIONS, ...READ_ONLY_ERP_ACTIONS];
  if (isOperator(user)) names.push(...OPERATOR_ERP_ACTIONS);
  return new Set(names);
}

// True when this person may call this action through this channel. The action
// layer enforces the same answer server-side; this is what decides whether the
// tool is offered at all, and the two must agree — an offer the server refuses
// teaches the model to promise and fail.
export function channelAllows(name, user, channel = "app") {
  if (channel === "app") {
    return isOperator(user) || gatedNames(user).has(name);
  }
  const excluded = PER_CHANNEL_EXCLUSIONS[channel] || PER_CHANNEL_EXCLUSIONS.telegram;
  return !excluded.has(name) && gatedNames(user).has(name);
}

// The tool names to declare to a model, in the declaration order the browser
// uses so every surface reads the same way.
export function channelToolNames(user, channel = "app") {
  return (isOperator(user) ? MILA_TOOLS : MILA_MEMBER_TOOLS)
    .map((tool) => tool.name)
    .filter((name) => channelAllows(name, user, channel));
}
