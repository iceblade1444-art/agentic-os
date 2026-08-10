// The ERP side of the daily briefing.
//
// Only what an owner needs to see before the day starts: orders that are already
// late, whether finished-goods stock could be read at all, and a finance line.
// Numbers come from the live ERP tools and are never invented — a tool that fails
// marks the section unavailable instead of contributing a zero.

import { erpBridge } from "./erp-bridge.js";

const CACHE_MS = 5 * 60 * 1000;
const clean = (value, max = 200) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function listValue(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.rows)) return value.rows;
  if (Array.isArray(value?.orders)) return value.orders;
  return [];
}

export function createErpDigest(options = {}) {
  const bridge = options.bridge || erpBridge;
  const now = options.now || (() => Date.now());
  let cache = null;

  async function read({ force = false } = {}) {
    if (!force && cache && now() - cache.at < CACHE_MS) return cache.value;
    if (!bridge.available()) {
      const value = { available: false, reason: "ERP MCP server is not registered" };
      cache = { at: now(), value };
      return value;
    }

    const [late, finished, finance] = await Promise.all([
      bridge.safeCall("erp_late_orders", { limit: 20 }),
      bridge.safeCall("erp_finished_goods_stock", { limit: 1 }),
      bridge.safeCall("erp_finance_summary"),
    ]);

    const lateData = late?.data || late;
    const lateRows = listValue(lateData);
    const lateCount = late?.ok === false ? null : firstNumber(lateData?.total, lateData?.count, lateRows.length);
    const finishedData = finished?.data || finished;
    const finishedPieces = finished?.ok === false
      ? null
      : firstNumber(finishedData?.total_pieces, finishedData?.answer_hints?.ready_goods_total_pieces);
    const financeData = finance?.data || finance;

    const flags = [];
    if (finished?.ok === false || finishedPieces === null) {
      flags.push({ id: "erp_fgs_missing", level: "normal", title: "Склад готовой продукции не читается", detail: "Проверьте ERP: /warehouse-stock" });
    }

    const value = {
      available: true,
      checkedAt: new Date(now()).toISOString(),
      lateOrders: lateCount,
      lateOrdersDetail: lateRows.slice(0, 3)
        .map((row) => clean(row.order_no || row.order || row.number || row.title, 60))
        .filter(Boolean).join(", "),
      finishedGoodsPieces: finishedPieces,
      financeFlag: clean(financeData?.headline || financeData?.summary, 160),
      flags,
    };
    cache = { at: now(), value };
    return value;
  }

  return { read, invalidate: () => { cache = null; } };
}

export const erpDigest = createErpDigest();
