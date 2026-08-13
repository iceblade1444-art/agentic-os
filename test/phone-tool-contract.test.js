import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { PERSONAL_ACTIONS, KNOWLEDGE_ACTIONS } from "../server/lib/mila-actions.js";

// The phone declares its own tool list to Gemini Live, in Dart, in the other
// repository, and that list ships inside an APK that people already have
// installed. A server change cannot reach those phones — so narrowing this gate
// does not "disable" a tool, it makes an installed MILA call something that
// comes back 403 in the middle of a conversation.
//
// This is the shipped contract, copied from milaPersonalToolNames in
// mila-agent/lib/services/voice/mila_live_tools.dart. Removing a name here is
// allowed; it just has to be a decision, taken knowing an older APK will start
// failing on it, rather than a side effect of tidying the allowlist.
const SHIPPED_PHONE_TOOLS = [
  "get_my_day_plan",
  "list_my_tasks", "create_my_task", "update_my_task",
  "list_my_notes", "save_my_note",
  "remind_me", "list_my_reminders", "cancel_reminder",
  "list_my_calendar",
  "search_company_knowledge", "read_company_knowledge", "list_company_knowledge",
  "remember_about_me", "read_about_me", "forget_about_me",
];

// Mirrors the route's own composition, which member-portal.test.js pins to the
// source. Kept here as data so this file can answer "would a Member get through"
// without booting the server or running the action for real.
const READ_ONLY_ERP_ACTIONS = new Set(["get_erp_business_context", "get_finished_goods_stock"]);
const allowedForEveryone = (name) =>
  READ_ONLY_ERP_ACTIONS.has(name) || PERSONAL_ACTIONS.has(name) || KNOWLEDGE_ACTIONS.has(name);

test("every tool a shipped phone can call still passes the gate for a Member", () => {
  for (const name of SHIPPED_PHONE_TOOLS) {
    assert.equal(
      allowedForEveryone(name),
      true,
      `${name} is declared by an installed APK; a Member calling it would now get 403`,
    );
  }
});

test("every tool a shipped phone can call still exists on the server", () => {
  // A rename is the quieter failure: the gate lets it through and the call dies
  // as an unknown action instead. The dispatcher matches on the name rather than
  // holding a registry, so this looks for the branch that handles it.
  const source = fs.readFileSync(new URL("../server/lib/mila-actions.js", import.meta.url), "utf8");
  for (const name of SHIPPED_PHONE_TOOLS) {
    assert.match(
      source,
      new RegExp(`["'\`]${name}["'\`]`),
      `${name} is declared by an installed APK but no longer exists on the server`,
    );
  }
});

test("the phone's copy of the list has not drifted from this one", { skip: !phoneList() }, () => {
  // Only runs on a machine that has both repositories checked out. CI has one of
  // them, so this cannot be the only guard — it is the one that catches the
  // drift early, while both sides are still on someone's disk.
  assert.deepEqual(phoneList().sort(), [...SHIPPED_PHONE_TOOLS].sort());
});

function phoneList() {
  const source = process.env.MILA_APP_DIR
    ? `${process.env.MILA_APP_DIR}/lib/services/voice/mila_live_tools.dart`
    : "C:/AI Agent/mila/lib/services/voice/mila_live_tools.dart";
  if (!fs.existsSync(source)) return null;
  const dart = fs.readFileSync(source, "utf8");
  const block = dart.slice(dart.indexOf("milaPersonalToolNames = ["));
  return [...block.slice(0, block.indexOf("];")).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

test("the gate never widens to something that reaches other people", () => {
  // Everything the gate lets a Member through acts on that Member's own desk.
  // These reach the company or a colleague, so they need operator rights however
  // the call arrives.
  for (const name of [
    "create_erp_task", "send_erp_notification",
    "create_kanban_task", "delegate_to_hermes", "write_obsidian_note",
    "ask_claude_code", "call_mcp_tool",
  ]) {
    assert.equal(allowedForEveryone(name), false, `${name} must stay operator-only`);
  }
});

test("calendar writes stay off the phone even though the gate allows them", () => {
  // A separate rule from the one above, and easy to confuse with it. Writing to
  // your own calendar is legitimately yours, so the server permits it — but the
  // dashboard puts an approval step in front of it and a voice call has nowhere
  // to show one. So the phone is never told the tool exists.
  for (const name of ["create_calendar_event", "reschedule_calendar_event", "cancel_calendar_event"]) {
    assert.equal(allowedForEveryone(name), true, `${name} is the caller's own calendar`);
    assert.equal(
      SHIPPED_PHONE_TOOLS.includes(name),
      false,
      `${name} would change a day from a voice call with no confirmation in front of it`,
    );
  }
  assert.ok(SHIPPED_PHONE_TOOLS.includes("list_my_calendar"), "reading it is fine");
});
