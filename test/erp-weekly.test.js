// The Monday review: live numbers with their week-over-week direction.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createErpWeekly } from "../server/lib/erp-weekly.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };

function fixture({ digestValue, when }) {
  const inbox = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-week-"));
  const file = path.join(dir, "erp-weekly.json");
  const instance = createErpWeekly({
    file,
    erpDigest: { read: async () => digestValue },
    pushService: { sendInbox: async (userId, item) => { inbox.push({ userId, item }); return { delivered: 1 }; } },
    journal: { append: async () => null },
    onboarding: { get: () => ({ profile: { timezone: "Asia/Tashkent" } }) },
    creatorUser: () => OWNER,
    now: () => new Date(when),
  });
  return { instance, inbox, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const DIGEST = { available: true, checkedAt: "2026-08-17T03:30:00.000Z", lateOrders: 4, lateOrdersDetail: "№451, №460", finishedGoodsPieces: 12100, financeFlag: "Касса в норме", flags: [] };

// 2026-08-17 is a Monday; 08:30 Tashkent is 03:30 UTC.
const MONDAY_MORNING = "2026-08-17T03:30:00.000Z";

test("the first Monday sends numbers, the second sends direction", async () => {
  const first = fixture({ digestValue: DIGEST, when: MONDAY_MORNING });
  const sent = await first.instance.tick();
  assert.equal(first.inbox[0].userId, OWNER.id);
  assert.match(sent.body, /Просроченные заказы: 4/);
  assert.match(sent.body, /первый недельный обзор/);

  // A week later, against the stored snapshot: fewer late orders, more stock.
  const nextWeek = createErpWeekly({
    // The same temp state file: next Monday reads this Monday's snapshot.
    file: first.file,
    erpDigest: { read: async () => ({ ...DIGEST, lateOrders: 2, finishedGoodsPieces: 12900 }) },
    pushService: { sendInbox: async (_u, item) => { first.inbox.push({ item }); return {}; } },
    journal: { append: async () => null },
    onboarding: { get: () => ({ profile: { timezone: "Asia/Tashkent" } }) },
    creatorUser: () => OWNER,
    now: () => new Date("2026-08-24T03:30:00.000Z"),
  });
  const second = await nextWeek.tick();
  assert.match(second.body, /Просроченные заказы: 2 \(▼ 2 за неделю\)/);
  assert.match(second.body, /12900 шт \(▲ 800 за неделю\)/);
  first.cleanup();
});

test("not Monday morning — silence; same Monday twice — once", async () => {
  const tuesday = fixture({ digestValue: DIGEST, when: "2026-08-18T05:00:00.000Z" });
  assert.equal(await tuesday.instance.tick(), null);
  tuesday.cleanup();

  const monday = fixture({ digestValue: DIGEST, when: MONDAY_MORNING });
  await monday.instance.tick();
  assert.equal(await monday.instance.tick(), null, "one review per Monday");
  assert.equal(monday.inbox.length, 1);
  monday.cleanup();
});

test("missing data is said, never zeroed, and never produces a delta", async () => {
  const f = fixture({ digestValue: { ...DIGEST, lateOrders: null, finishedGoodsPieces: null }, when: MONDAY_MORNING });
  const sent = await f.instance.tick();
  assert.match(sent.body, /Просроченные заказы: нет данных/);
  assert.match(sent.body, /Склад готовой продукции: нет данных/);
  assert.equal(sent.body.includes("▲"), false);
  assert.equal(sent.body.includes("▼"), false);
  f.cleanup();
});

test("an unavailable ERP sends nothing at all", async () => {
  const f = fixture({ digestValue: { available: false }, when: MONDAY_MORNING });
  assert.equal(await f.instance.tick(), null);
  assert.equal(f.inbox.length, 0);
  f.cleanup();
});
