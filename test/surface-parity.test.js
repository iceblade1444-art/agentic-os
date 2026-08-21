// One assistant, four doors.
//
// The browser, the phone, a linked Telegram chat and the team messenger all
// reach the same MILA, and every one of them used to keep its own hand-written
// list of what she can do there. They drifted, quietly and in both directions:
// the calendar writes the browser had never reached Telegram, and the tools
// added for the turnstile reached Telegram before the phone. These tests hold
// the doors to one definition — the audience gates in mila-actions.js — so a
// tool added to a gate appears everywhere it is allowed and nowhere it is not.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  KNOWLEDGE_ACTIONS,
  OPERATOR_ERP_ACTIONS,
  PERSONAL_ACTIONS,
  READ_ONLY_ERP_ACTIONS,
} from "../server/lib/mila-actions.js";
import { MILA_MEMBER_TOOLS, MILA_TOOLS } from "../assets/js/mila-tools.js";
import { toolNamesFor } from "../server/lib/telegram-assistant.js";

const OWNER = { id: "creator", name: "Владелец", role: "Creator" };
const CEO = { id: "usr_ceo", name: "CEO", role: "CEO" };
const MEMBER = { id: "usr_2", name: "Сотрудник", role: "Member" };

const source = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");

const telegramTools = (user) => new Set(toolNamesFor(user));

test("the gates are defined once and imported, never restated", () => {
  // A second copy of a gate is how the drift started; these files must read the
  // shared definition rather than spell the tool names out again.
  for (const file of ["../server/routes/mila-actions.js", "../server/lib/telegram-assistant.js", "../server/lib/messenger-mila.js"]) {
    const text = source(file);
    assert.match(text, /READ_ONLY_ERP_ACTIONS/, `${file} must import the shared gate`);
    assert.doesNotMatch(
      text,
      /\[\s*"get_erp_business_context",\s*"get_finished_goods_stock"/,
      `${file} restates the ERP read list instead of importing it`,
    );
  }
});

test("every gated action is a declared tool somewhere, and no tool is gated into nowhere", () => {
  const declared = new Set(MILA_TOOLS.map((tool) => tool.name));
  for (const name of [...PERSONAL_ACTIONS, ...KNOWLEDGE_ACTIONS, ...READ_ONLY_ERP_ACTIONS, ...OPERATOR_ERP_ACTIONS]) {
    assert.ok(declared.has(name), `${name} is allowed by a gate but declared to no one`);
  }
  // What a Member is offered in the browser is exactly what the everyone-gates
  // permit: an offer the server will refuse teaches MILA to promise and fail.
  for (const tool of MILA_MEMBER_TOOLS) {
    const permitted = PERSONAL_ACTIONS.has(tool.name) || KNOWLEDGE_ACTIONS.has(tool.name) || READ_ONLY_ERP_ACTIONS.has(tool.name);
    assert.ok(permitted, `${tool.name} is offered to a Member in the browser but no gate allows it`);
  }
});

test("Telegram offers a Member the same desk the browser does", () => {
  const inChat = telegramTools(MEMBER);
  const inBrowser = MILA_MEMBER_TOOLS.map((tool) => tool.name)
    // send_telegram reaches this very chat from elsewhere; inside it, it is an echo.
    .filter((name) => name !== "send_telegram");

  const missing = inBrowser.filter((name) => !inChat.has(name));
  assert.deepEqual(missing, [], "a tool the browser offers a Member must work in their linked chat too");
  for (const name of OPERATOR_ERP_ACTIONS) {
    assert.equal(inChat.has(name), false, `${name} is staff data and must not reach a Member anywhere`);
  }
});

test("an operator chat carries the staff tools; a Member never does", () => {
  const owner = telegramTools(OWNER);
  for (const name of OPERATOR_ERP_ACTIONS) {
    assert.ok(owner.has(name), `${name} must reach an operator's own chat`);
  }
  assert.ok(owner.has("create_calendar_event"), "an operator keeps the personal desk too");
});

test("CEO is an operator on every surface, not only where it was remembered", () => {
  // The role was added late; each surface had its own list of who counts.
  for (const file of ["../server/routes/mila-actions.js", "../server/lib/telegram-assistant.js", "../server/lib/hermes-proxy.js", "../server/lib/company-brief.js"]) {
    assert.match(source(file), /"CEO"/, `${file} must recognise the CEO role`);
  }
  assert.notEqual(CEO.role, "Admin");
});
