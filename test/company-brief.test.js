// The company half of the morning brief: rich for an operator, absent for a
// Member, silent about anything it could not actually read.

import assert from "node:assert/strict";
import test from "node:test";

import { createCompanyBrief } from "../server/lib/company-brief.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };
const MEMBER = { id: "usr_2", name: "Шавкат", role: "Member" };
const NOW = () => new Date("2026-08-18T03:10:00.000Z"); // 08:10 Tashkent, Aug 18

const SEWING = (total, lines) => ({
  ok: true,
  data: {
    report_date: "x", factory_code: "MIL",
    reports: {
      total_sewn_qty: total, total_defective_qty: 0,
      rows: Array.from({ length: lines }, (_, index) => ({ line_code: `SEW-0${index + 1}`, line_name: `Линия ${index + 1}`, sewn_qty: total / lines, defective_qty: 0, model_no: "Pj-1" })),
    },
    flows: [],
  },
});


// The real board on 2026-08-19: late is the norm, and seven of those never
// started — the distinction the brief has to carry.
const BOARD = {
  ok: true,
  data: {
    orders: [
      ...Array.from({ length: 16 }, (_, i) => ({ production_no: `PO-C${i}`, current_stage: "cutting", po_overdue: i < 7, po_deadline: "2026-08-04T00:00:00+00:00", actual_quantity: i < 7 ? 0 : 100 })),
      ...Array.from({ length: 22 }, (_, i) => ({ production_no: `PO-S${i}`, current_stage: "sewing", po_overdue: i < 20, actual_quantity: 300 })),
      ...Array.from({ length: 8 }, (_, i) => ({ production_no: `PO-P${i}`, current_stage: "packaging", po_overdue: i < 8, actual_quantity: 500 })),
    ],
  },
};

// The turnstile serves only the current snapshot, whatever date it is asked
// for, so the brief must date the line by the clock and never by "yesterday".
const GATE = { ok: true, data: { date: "2026-08-18", overview: { date: "2026-08-18", summary: { total_people: 1508, used_today: 384, not_used_today: 1124 } } } };

function fixture(overrides = {}) {
  return createCompanyBrief({
    now: NOW,
    erpBridge: {
      call: async (tool, args) => tool === "erp_process_tracking"
        ? BOARD
        : tool === "erp_attendance_overview"
          ? GATE
          : (args.report_date === "2026-08-17" ? SEWING(5284, 6) : SEWING(4800, 6)),
    },
    erpDigest: { read: async () => ({ available: true, lateOrders: 0, lateOrdersDetail: "", finishedGoodsPieces: 12900, financeFlag: "Касса в норме" }) },
    salesBot: { configured: () => true, leads: () => [
      { createdAt: "2026-08-17T10:00:00.000Z", status: "new" },
      { createdAt: "2026-08-17T15:00:00.000Z", status: "contacted" },
      { createdAt: "2026-08-10T10:00:00.000Z", status: "new" },
    ] },
    messenger: { listFor: () => [
      { kind: "channel", name: "производство", unread: 7, mentioned: true },
      { kind: "direct", name: "Шавкат", unread: 2, mentioned: false },
    ] },
    mfa: { status: () => ({ eligible: true, enabled: true }) },
    journal: { recentEntries: () => [
      { date: "2026-08-17", title: "Протокол: Планёрка по отгрузке" },
      { date: "2026-08-17", title: "Новый лид из Telegram" },
      { date: "2026-08-16", title: "Позавчерашнее — не для этой сводки" },
    ] },
    ...overrides,
  });
}

test("an operator gets the four blocks, with yesterday's sewing and its direction", async () => {
  const text = await fixture().blocks(OWNER, "Asia/Tashkent");
  assert.match(text, /Швейка вчера: 5284 шт по 6 линиям \(▲ 484\)/);
  assert.match(text, /Заказы в производстве: 46 — крой 16, швейка 22, упаковка 8/);
  assert.match(text, /За сроком: 35, из них 7 ещё не начаты/);
  assert.match(text, /Не начаты: PO-C0 \(срок 2026-08-04\)/, "the stalled orders are named, not just counted");
  assert.match(text, /Явка на 08:10: 384 из 1508/, "attendance is stamped with the clock, never called yesterday's");
  assert.match(text, /Просрочки по клиентским заказам: 0/);
  assert.match(text, /Склад готовой продукции: 12900 шт/);
  assert.match(text, /Новых лидов за вчера: 2/);
  assert.match(text, /Ждут ответа менеджера: 2/);
  assert.match(text, /Непрочитанных: 9 — #производство \(7\), Шавкат \(2\)/);
  assert.match(text, /Вас упомянули: #производство/);
  assert.match(text, /Протокол: Планёрка по отгрузке/);
  assert.equal(text.includes("Позавчерашнее"), false, "yesterday means yesterday");
});

test("a Member's brief stays their own plan", async () => {
  assert.equal(await fixture().blocks(MEMBER, "Asia/Tashkent"), "");
});

test("a quiet company prints nothing extra, and a dead ERP costs its block only", async () => {
  const quiet = fixture({
    erpBridge: { call: async () => { throw new Error("ERP down"); } },
    erpDigest: { read: async () => ({ available: false }) },
    salesBot: { configured: () => false, leads: () => [] },
    messenger: { listFor: () => [] },
    journal: { recentEntries: () => [] },
  });
  assert.equal(await quiet.blocks(OWNER, "Asia/Tashkent"), "", "no invented lines on a quiet morning");

  const erpDead = fixture({
    erpBridge: { call: async () => { throw new Error("ERP down"); } },
    erpDigest: { read: async () => ({ available: false }) },
  });
  const text = await erpDead.blocks(OWNER, "Asia/Tashkent");
  assert.equal(text.includes("Производство"), false, "the ERP block is absent, not zeroed");
  assert.match(text, /Непрочитанных/, "the team block survives an ERP outage");
});

test("a day off before yesterday produces no delta, not a triumph over zero", async () => {
  const brief = fixtureWithEmptyDayBefore();
  const text = await brief.blocks(OWNER, "Asia/Tashkent");
  assert.match(text, /Швейка вчера: 5284 шт по 6 линиям/);
  assert.equal(text.includes("▲"), false, "▲ against a Sunday is not information");
});

function fixtureWithEmptyDayBefore() {
  return createCompanyBrief({
    now: NOW,
    erpBridge: {
      call: async (_tool, args) => args.report_date === "2026-08-17"
        ? SEWING(5284, 6)
        : { ok: true, data: { reports: { rows: [], total_sewn_qty: 0 }, flows: [] } },
    },
    erpDigest: { read: async () => ({ available: false }) },
    salesBot: { configured: () => false, leads: () => [] },
    messenger: { listFor: () => [] },
    journal: { recentEntries: () => [] },
  });
}

test("an operator without a second factor is told once a morning, and only until they enable it", async () => {
  const off = fixture({ mfa: { status: () => ({ eligible: true, enabled: false }) } });
  assert.match(await off.blocks(OWNER, "Asia/Tashkent"), /Двухфакторная защита выключена/);

  // The day it is switched on the line disappears: a nudge that ends by itself.
  const on = fixture({ mfa: { status: () => ({ eligible: true, enabled: true }) } });
  assert.equal((await on.blocks(OWNER, "Asia/Tashkent")).includes("Двухфакторная"), false);

  // A role that cannot use MFA is not nagged about it.
  const notEligible = fixture({ mfa: { status: () => ({ eligible: false, enabled: false }) } });
  assert.equal((await notEligible.blocks(OWNER, "Asia/Tashkent")).includes("Двухфакторная"), false);

  // A broken MFA store costs its line, never the brief.
  const broken = fixture({ mfa: { status: () => { throw new Error("mfa.json unreadable"); } } });
  assert.match(await broken.blocks(OWNER, "Asia/Tashkent"), /Швейка вчера/);
});
