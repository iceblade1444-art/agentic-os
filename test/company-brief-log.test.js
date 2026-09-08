// The brief keeps a failed number out of the message. That rule stands. But
// four mornings went out without a production block and no log line said
// why — so every failure the brief swallows is now named in the log.
import assert from "node:assert/strict";
import test from "node:test";

import { createCompanyBrief } from "../server/lib/company-brief.js";
import { createErpDigest } from "../server/lib/erp-digest.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };
const NOW = () => new Date("2026-09-08T03:05:00.000Z"); // 08:05 Tashkent — brief time

const quiet = {
  salesBot: { configured: () => false },
  messenger: { listFor: () => [] },
  journal: { recentEntries: () => [] },
  mfa: { enabled: () => true },
};

test("every ERP failure the brief swallows is named in the log", async () => {
  const log = [];
  const brief = createCompanyBrief({
    ...quiet,
    now: NOW,
    log: (message) => log.push(message),
    erpBridge: {
      call: async (tool) => {
        if (tool === "erp_process_tracking") throw new Error("MCP error -32001: Request timed out");
        return { ok: false, tool, error: { message: "ERP API request failed", status_code: 502 } };
      },
    },
    erpDigest: { read: async () => ({ available: false, reason: "ERP MCP server is not registered" }) },
  });
  const text = await brief.blocks(OWNER, "Asia/Tashkent");
  assert.doesNotMatch(text, /Производство/, "a failed block is still not printed");
  assert.ok(log.some((line) => /erp_sewing_daily_report: ERP API request failed/.test(line)), log.join("\n"));
  assert.ok(log.some((line) => /erp_process_tracking: .*timed out/.test(line)), log.join("\n"));
  assert.ok(log.some((line) => /erp_attendance_overview: ERP API request failed/.test(line)), log.join("\n"));
  assert.ok(log.some((line) => /digest: ERP MCP server is not registered/.test(line)), log.join("\n"));
});

test("a healthy morning logs nothing", async () => {
  const log = [];
  const brief = createCompanyBrief({
    ...quiet,
    now: NOW,
    log: (message) => log.push(message),
    erpBridge: { call: async () => ({ ok: true, data: {} }) },
    erpDigest: { read: async () => ({ available: true, lateOrders: 0, finishedGoodsPieces: 1129, financeFlag: "" }) },
  });
  const text = await brief.blocks(OWNER, "Asia/Tashkent");
  assert.match(text, /Склад готовой продукции: 1129 шт/);
  assert.deepEqual(log, []);
});

test("the digest names the tool that failed instead of quietly returning null", async () => {
  const log = [];
  const digest = createErpDigest({
    log: (message) => log.push(message),
    bridge: {
      available: () => true,
      safeCall: async (tool) => tool === "erp_finished_goods_stock"
        ? { ok: false, tool, error: { message: "MCP error -32001: Request timed out" } }
        : { ok: true, data: { total: 0 } },
    },
  });
  const value = await digest.read({ force: true });
  assert.equal(value.finishedGoodsPieces, null, "still never a zero");
  assert.equal(value.lateOrders, 0);
  assert.deepEqual(log, ["erp_finished_goods_stock: MCP error -32001: Request timed out"]);
});
