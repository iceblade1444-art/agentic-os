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
import { LIVEKIT_BASELINE_TOOLS, voiceInstruction } from "../server/lib/voice-instruction.js";

const OWNER = { id: "creator", name: "Владелец", role: "Creator" };
const CEO = { id: "usr_ceo", name: "CEO", role: "CEO" };
const MEMBER = { id: "usr_2", name: "Сотрудник", role: "Member" };

const source = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");

const telegramTools = (user) => new Set(toolNamesFor(user));

test("the gates are defined once and imported, never restated", () => {
  // A second copy of a gate is how the drift started. Each surface either
  // imports the gate itself or asks mila-audience.js, which owns the answer.
  for (const file of [
    "../server/routes/mila-actions.js",
    "../server/lib/telegram-assistant.js",
    "../server/lib/messenger-mila.js",
    "../server/lib/voice-instruction.js",
  ]) {
    const text = source(file);
    assert.match(text, /READ_ONLY_ERP_ACTIONS|mila-audience\.js/, `${file} must read the shared gate, not its own copy`);
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

test("the phone asks the server what it may do, and is told the same as the chat", () => {
  // The phone's list lived in Dart, so tools added on the server never reached
  // it. Naming the channel makes the server answer with this person's set.
  const operator = voiceInstruction(OWNER, { channel: "mobile" }).tools;
  const member = voiceInstruction(MEMBER, { channel: "mobile" }).tools;

  for (const name of OPERATOR_ERP_ACTIONS) {
    assert.ok(operator.includes(name), `${name} must reach an operator's phone`);
    assert.equal(member.includes(name), false, `${name} must not reach a Member's phone`);
  }
  for (const name of READ_ONLY_ERP_ACTIONS) {
    assert.ok(member.includes(name), `${name} is readable by everyone and must reach the phone`);
  }
  // Host-level reach is not a phone capability on any role.
  for (const name of ["ask_claude_code", "call_mcp_tool", "write_obsidian_note", "create_kanban_task"]) {
    assert.equal(operator.includes(name), false, `${name} must not travel through the phone`);
  }
  // The chat and the phone differ only where the channel itself makes a tool
  // meaningless; anything else is drift.
  const chat = toolNamesFor(OWNER);
  const onlyOnPhone = operator.filter((name) => !chat.includes(name));
  assert.deepEqual(onlyOnPhone, ["send_telegram"], "the phone can reach a Telegram chat; the chat cannot reach itself");
  assert.deepEqual(chat.filter((name) => !operator.includes(name)), []);
});

test("a caller that names no channel keeps the old behaviour", () => {
  // The LiveKit agent registers its tools in Python and announces them; a list
  // it did not choose would be a promise it cannot keep.
  const baseline = voiceInstruction(OWNER, {}).tools;
  assert.deepEqual(baseline, LIVEKIT_BASELINE_TOOLS);
  const announced = voiceInstruction(OWNER, { tools: ["get_finished_goods_stock"] }).tools;
  assert.deepEqual(announced, ["get_finished_goods_stock"]);
});

test("CEO is an operator on every surface, not only where it was remembered", () => {
  // The role was added late; each surface had its own list of who counts, and
  // one forgotten list is a silent demotion. Where a surface delegates, the
  // module it delegates to answers instead.
  for (const file of ["../server/routes/mila-actions.js", "../server/lib/mila-audience.js", "../server/lib/hermes-proxy.js", "../server/lib/company-brief.js"]) {
    assert.match(source(file), /"CEO"/, `${file} must recognise the CEO role`);
  }
  // And behaviourally, not only in the source: a CEO is offered what an owner is.
  assert.deepEqual(toolNamesFor(CEO), toolNamesFor(OWNER));
  assert.deepEqual(voiceInstruction(CEO, { channel: "mobile" }).tools, voiceInstruction(OWNER, { channel: "mobile" }).tools);
});
