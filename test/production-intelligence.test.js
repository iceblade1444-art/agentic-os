import assert from "node:assert/strict";
import test from "node:test";

import {
  accountIdentity, calculateProductionIntelligence, ownedRows, ProductionIntelligence,
} from "../server/lib/production-intelligence.js";

test("production KPIs are calculated by deterministic formulas, not the LLM", () => {
  const result = calculateProductionIntelligence({
    erp_active_production: { data: { items: [
      { line: "L1", planned_quantity: 100, actual_quantity: 70, sam: 12, available_minutes: 1000, inspected: 65, first_pass_good: 60, defects: 5, rework: 3, downtime_minutes: 95, downtime_reason: "Нет кроя", reason_confirmed: true, updated_at: "2026-11-11T08:00:00Z" },
    ] } },
    erp_business_control: { data: { shipped_orders: 10, on_time_orders: 9 } },
    erp_late_orders: { data: { items: [{ order_no: "A-1" }] } },
    erp_list_employee_tasks: { data: { items: [{ id: 1 }] } },
  });
  assert.equal(result.metrics.planFactPercent, 70);
  assert.equal(result.metrics.efficiencySamPercent, 84);
  assert.equal(result.metrics.firstPassYieldPercent, 92.3);
  assert.equal(result.metrics.onTimeDeliveryPercent, 90);
  assert.equal(result.metrics.downtimeMinutes, 95);
  assert.equal(result.metrics.lateOrders, 1);
  assert.equal(result.findings[0].assumedReason, "Нет кроя");
  assert.equal(result.findings[0].responsibility, null, "the engine must never auto-assign blame");
});

test("missing source fields remain unknown and lower confidence", () => {
  const result = calculateProductionIntelligence({ erp_active_production: { data: {} } });
  assert.equal(result.metrics.planFactPercent, null);
  assert.equal(result.metrics.firstPassYieldPercent, null);
  assert.ok(result.quality.missingData.length >= 4);
  assert.equal(result.findings.length, 0);
});

test("employee ownership uses an explicit account link and rejects neighbouring rows", () => {
  const user = { id: "usr_1", email: "one@example.test", name: "One", role: "Member" };
  const identity = accountIdentity(user, { usr_1: { employeeId: "17" } });
  const filtered = ownedRows([
    { id: 1, assigned_to: 17 },
    { id: 2, assigned_to: 18 },
    { id: 3, employee_email: "one@example.test" },
  ], identity);
  assert.deepEqual(filtered.map((item) => item.id), [1, 3]);
});

test("a member receives only linked ERP tasks and no company metrics", async () => {
  const bridge = { safeCall: async () => ({ ok: true, data: { items: [
    { id: "mine", assigned_to: 17 }, { id: "other", assigned_to: 18 },
  ] } }) };
  const service = new ProductionIntelligence({ databaseUrl: "", bridge, links: { usr_1: { employeeId: "17" } } });
  const result = await service.dashboard({ id: "usr_1", role: "Member" });
  assert.equal(result.access, "own");
  assert.deepEqual(result.tasks.map((item) => item.id), ["mine"]);
  assert.deepEqual(result.metrics, { taskCount: 1 });
});

test("an unlinked member is denied instead of inheriting the shared ERP identity", async () => {
  const service = new ProductionIntelligence({ databaseUrl: "", bridge: { safeCall: () => assert.fail("ERP must not be called") }, links: {} });
  const result = await service.dashboard({ id: "usr_1", email: "one@example.test", role: "Member" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "erp_identity_not_linked");
});

test("an email-only link cannot bypass the ERP numeric user-id filter", async () => {
  const service = new ProductionIntelligence({
    databaseUrl: "",
    bridge: { safeCall: () => assert.fail("ERP must not be called") },
    links: { usr_1: { email: "one@example.test" } },
  });
  const result = await service.dashboard({ id: "usr_1", email: "one@example.test", role: "Member" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "erp_identity_not_linked");
});

test("a snapshot and its decision log commit on one PostgreSQL client", async () => {
  const outer = [];
  const transaction = [];
  let released = false;
  const pool = {
    query: async (sql) => { outer.push(sql); return { rows: [] }; },
    connect: async () => ({
      query: async (sql) => { transaction.push(sql); return { rows: [] }; },
      release: () => { released = true; },
    }),
  };
  const bridge = { safeCall: async (tool) => tool === "erp_active_production"
    ? { data: { items: [{ planned_quantity: 10, actual_quantity: 8 }] } }
    : { data: {} } };
  const service = new ProductionIntelligence({ databaseUrl: "postgres://test", pool, bridge });
  service.ready = Promise.resolve(true);
  const result = await service.sync();
  assert.equal(result.metrics.planFactPercent, 80);
  assert.equal(transaction[0], "BEGIN");
  assert.match(transaction.join("\n"), /INSERT INTO mila_production\.snapshots/);
  assert.equal(transaction.at(-1), "COMMIT");
  assert.equal(released, true);
  assert.equal(outer.some((sql) => sql === "BEGIN" || sql === "COMMIT"), false);
});
