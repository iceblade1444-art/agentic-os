// Staff data through MILA: aggregated in code, honest about permissions, and
// operator-only on every surface.

import assert from "node:assert/strict";
import test from "node:test";

import { createMilaActions, staffFacts, attendanceFacts } from "../server/lib/mila-actions.js";
import { createTelegramAssistant } from "../server/lib/telegram-assistant.js";
import { MILA_MEMBER_TOOLS, MILA_TOOLS } from "../assets/js/mila-tools.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };
const MEMBER = { id: "usr_2", name: "Шавкат", role: "Member" };

test("hundreds of directory rows collapse to headcount by department", () => {
  const employees = [];
  for (let index = 0; index < 300; index += 1) {
    employees.push({ full_name: `Сотрудник ${index}`, department_id: index % 3, status: index % 10 === 0 ? "inactive" : "active" });
  }
  const facts = staffFacts({
    employees,
    departments: [{ id: 0, name: "Швейный цех" }, { id: 1, name: "Крой" }, { id: 2, name: "Склад" }],
  });
  assert.equal(facts.total, 300);
  assert.equal(facts.active, 270);
  assert.equal(facts.departments.length, 3);
  assert.equal(facts.departments[0].department, "Швейный цех");
  assert.match(facts.answer_summary, /300 сотрудников, активных 270/);
  assert.ok(JSON.stringify(facts).length < 2000, "the result must survive the tool clamp");
});

test("the attendance overview keeps recognizable totals and never hands over broken JSON", () => {
  const known = attendanceFacts({ date: "2026-08-18", overview: { present_count: 1432, late: 12, total: 1500 } });
  assert.equal(known.present, 1432);
  assert.equal(known.late, 12);
  assert.equal(known.total, 1500);

  // The shape the live ERP actually returns: a Hikvision turnstile overview
  // with the totals nested under summary and a people array too big to carry.
  const live = attendanceFacts({
    date: "2026-08-18",
    overview: {
      date: "2026-08-18",
      summary: { total_people: 1500, used_today: 207, not_used_today: 1293, events_today: 626, unmatched_events: 417 },
      devices: [{ id: 1, name: "Main turnstile", vendor: "Hikvision" }],
      people: Array.from({ length: 300 }, (_, index) => ({ id: index, full_name: `Сотрудник ${index}` })),
    },
  });
  assert.equal(live.present, 207);
  assert.equal(live.absent, 1293);
  assert.equal(live.total, 1500);
  assert.equal(live.unmatched_events, 417);
  assert.match(live.answer_summary, /207 из 1500/);
  assert.equal(live.overview, undefined, "the people list stays behind");

  const huge = attendanceFacts({ date: "2026-08-18", overview: { rows: Array.from({ length: 200 }, (_, index) => ({ name: `x${index}`, detail: "y".repeat(40) })) } });
  assert.equal(huge.overview, undefined, "an oversized overview is omitted");
  assert.match(huge.overview_note, /omitted/);
});

test("the missing attendance permission is reported, not papered over", async () => {
  const actions = createMilaActions({
    erpBridge: {
      available: () => true,
      call: async () => ({ ok: false, error: { status_code: 403, message: "ERP permission denied for this tool.", path: "/api/attendance/overview" } }),
    },
    journal: { append: async () => null, recentText: () => "" },
    onboarding: { get: () => ({ profile: {} }) },
    db: { mcp: { list: () => [], update: () => {} } },
  });
  const result = await actions.call("get_attendance_today", {}, { actor: OWNER.name, user: OWNER });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /permission/i);
});

test("staff tools exist for operators and nowhere else", () => {
  for (const name of ["get_attendance_today", "get_staff_summary"]) {
    assert.ok(MILA_TOOLS.some((tool) => tool.name === name), `${name} declared for operators`);
    assert.equal(MILA_MEMBER_TOOLS.some((tool) => tool.name === name), false, `${name} must not reach a Member`);
  }
});

test("in Telegram the turnstile follows the role", async () => {
  const calls = [];
  function assistantFor(user) {
    return createTelegramAssistant({
      chat: (() => {
        let step = 0;
        const script = ['TOOL_CALL {"name":"get_attendance_today","args":{}}', "Ответ."];
        return async (_cfg, _label, request) => { assistantFor.lastPrompt = request.systemPrompt; return { text: script[Math.min(step++, 1)] }; };
      })(),
      actions: { call: async (name) => { calls.push({ name, as: user.id }); return { ok: true }; } },
      sharedAgentContext: () => "ctx",
      db: { integrations: { byProvider: () => ({ config: { baseUrl: "http://mila.test" } }) } },
      users: { get: (id) => (id === MEMBER.id ? MEMBER : null) },
      creatorUser: () => OWNER,
    });
  }

  await assistantFor(OWNER).respond("creator", "кто сегодня на месте?");
  assert.deepEqual(calls, [{ name: "get_attendance_today", as: "creator" }]);
  assert.match(assistantFor.lastPrompt, /get_attendance_today/);

  await assistantFor(MEMBER).respond(MEMBER.id, "кто сегодня на месте?");
  assert.equal(calls.length, 1, "a Member's TOOL_CALL for the turnstile must not execute");
  assert.equal(assistantFor.lastPrompt.includes("get_attendance_today"), false, "and their prompt never offers it");
});
