// The /processes board through MILA: compacted to one line per order,
// worst news first, operator-only everywhere.

import assert from "node:assert/strict";
import test from "node:test";

import { processFacts } from "../server/lib/mila-actions.js";
import { MILA_MEMBER_TOOLS, MILA_TOOLS } from "../assets/js/mila-tools.js";

// The live row shape from /api/process-tracking, ~3KB each in the wild.
const row = (over = {}) => ({
  production_no: "PO-2026-000117", order_no: "SO-2026-000117", sales_order_no: null,
  customer_name: null, model_code: "KJ13027-V-5860", model_name: "Komplekt",
  planned_quantity: 600, actual_quantity: 0,
  po_deadline: "2026-08-24T00:00:00+00:00", po_overdue: false,
  current_stage: "cutting", current_stage_status: "waiting",
  is_blocked: false, blocked_by: null,
  sizes: Array.from({ length: 6 }, (_, index) => ({ size: String(46 + index * 2), planned_quantity: 100, completed_quantity: 0 })),
  stages: [{ work_order_id: 510, operation: "cutting", status: "waiting", planned: 600, completed: 0 }],
  model_image_url: "/storage/model-files/model.png",
  ...over,
});

test("a full board compacts to totals plus one line per order, worst first", () => {
  const orders = [
    ...Array.from({ length: 16 }, (_, i) => row({ production_no: `PO-C${i}` })),
    ...Array.from({ length: 20 }, (_, i) => row({ production_no: `PO-S${i}`, current_stage: "sewing", current_stage_status: "in_progress", actual_quantity: 250 })),
    ...Array.from({ length: 8 }, (_, i) => row({ production_no: `PO-P${i}`, current_stage: "packaging", current_stage_status: "in_progress" })),
    row({ production_no: "PO-LATE", po_overdue: true, po_deadline: "2026-08-10T00:00:00+00:00", customer_name: "ООО Заказчик" }),
    row({ production_no: "PO-DONE", current_stage: "completed", current_stage_status: null }),
  ];
  const facts = processFacts({ orders });
  assert.equal(facts.total_in_work, 46);
  assert.deepEqual(facts.by_stage, { "крой": 17, "швейка": 20, "упаковка": 8, "готово": 1 });
  assert.equal(facts.overdue, 1);
  assert.match(facts.answer_summary, /Заказов в работе: 46/);
  assert.match(facts.answer_summary, /просрочено: 1/);
  assert.equal(facts.orders[0].order, "PO-LATE", "the overdue order speaks first");
  assert.equal(facts.orders[0].overdue, true);
  assert.equal(facts.orders[0].customer, "ООО Заказчик");
  assert.equal(facts.orders.length, 25, "the list is capped");
  assert.match(facts.orders_note, /46/);
  assert.ok(JSON.stringify(facts).length < 4000, "the result must survive the tool clamp");
});

test("stage and query filters narrow the list in either language", () => {
  const orders = [row(), row({ production_no: "PO-2", current_stage: "sewing", model_code: "PJ-777" })];
  const sewing = processFacts({ orders }, { stage: "швейка" });
  assert.equal(sewing.filtered_count, 1);
  assert.equal(sewing.orders[0].order, "PO-2");
  assert.equal(sewing.total_in_work, 2, "totals still describe the whole board");
  const byModel = processFacts({ orders }, { query: "pj-777" });
  assert.equal(byModel.orders.length, 1);
  assert.equal(processFacts({ orders }, { stage: "cutting" }).orders[0].order, "PO-2026-000117");
});

test("the order board is declared for operators and hidden from Members", () => {
  assert.ok(MILA_TOOLS.some((tool) => tool.name === "get_order_stages"));
  assert.equal(MILA_MEMBER_TOOLS.some((tool) => tool.name === "get_order_stages"), false);
});
