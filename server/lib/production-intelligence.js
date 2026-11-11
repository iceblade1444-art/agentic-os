import crypto from "node:crypto";
import pg from "pg";

import { config } from "../config.js";
import { erpBridge } from "./erp-bridge.js";

const { Pool } = pg;
const EXECUTIVE_ROLES = new Set(["Creator", "Admin", "CEO"]);
const TOOLS = [
  ["erp_active_production", { limit: 250 }],
  ["erp_business_control", { limit: 250 }],
  ["erp_late_orders", { limit: 250 }],
  ["erp_inventory_status", {}],
  ["erp_finance_summary", {}],
  ["erp_list_employee_tasks", { limit: 250 }],
];

const clean = (value, max = 160) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
const number = (...values) => {
  for (const value of values) {
    if (value === "" || value === null || value === undefined) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};
const round = (value, digits = 1) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const unwrap = (value) => value?.data ?? value ?? {};
const rows = (value) => {
  const data = unwrap(value);
  if (Array.isArray(data)) return data;
  for (const key of ["items", "rows", "orders", "tasks", "results", "data"]) {
    if (Array.isArray(data?.[key])) return data[key];
    if (Array.isArray(data?.[key]?.items)) return data[key].items;
  }
  return [];
};
const sum = (items, read) => {
  let total = 0;
  let found = false;
  for (const item of items) {
    const value = read(item);
    if (!Number.isFinite(value)) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
};
const percent = (numerator, denominator) => Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
  ? round(numerator / denominator * 100) : null;
const newest = (items) => {
  const values = items.flatMap((item) => [item?.updated_at, item?.updatedAt, item?.captured_at, item?.date])
    .map((value) => Date.parse(value)).filter(Number.isFinite);
  return values.length ? new Date(Math.max(...values)).toISOString() : null;
};

const ownershipValues = (row) => [
  row?.employee_id, row?.employeeId, row?.user_id, row?.userId, row?.assigned_to, row?.assignedTo, row?.assignee_user_id,
  row?.assigneeUserId, row?.employee_email, row?.employeeEmail, row?.assignee_email,
  row?.assigneeEmail, row?.owner_email, row?.ownerEmail, row?.responsible_email,
  row?.responsibleEmail, row?.employee, row?.assignee, row?.owner, row?.responsible,
].map((value) => clean(value, 200).toLowerCase()).filter(Boolean);

export function accountIdentity(user = {}, links = {}) {
  const configured = links?.[user.id] || links?.[String(user.email || "").toLowerCase()] || {};
  const values = [user.id, user.email, configured.employeeId, configured.email, configured.name]
    .map((value) => clean(value, 200).toLowerCase()).filter(Boolean);
  return { values: new Set(values), configured: Boolean(clean(configured.employeeId, 40)), configuredLink: configured };
}

export function ownedRows(items, identity) {
  if (!identity?.values?.size) return [];
  return items.filter((item) => ownershipValues(item).some((value) => identity.values.has(value)));
}

function causeEvidence(productionRows, control) {
  const evidence = [];
  for (const item of productionRows) {
    const minutes = number(item.downtime_minutes, item.downtimeMinutes, item.stop_minutes, item.stopMinutes);
    const reason = clean(item.downtime_reason || item.stop_reason || item.reason || item.blocker, 240);
    if (Number.isFinite(minutes) || reason) evidence.push({
      scope: clean(item.line_name || item.line || item.scope_name || item.order_no, 120),
      minutes,
      reason: reason || null,
      confirmed: Boolean(item.reason_confirmed ?? item.confirmed ?? reason),
    });
  }
  for (const item of rows(control?.blocked_orders || control?.blockedOrders)) {
    evidence.push({
      scope: clean(item.line_name || item.line || item.order_no || item.production_no, 120),
      minutes: number(item.downtime_minutes, item.stop_minutes),
      reason: clean(item.reason || item.blocker, 240) || null,
      confirmed: Boolean(item.reason_confirmed ?? item.confirmed),
    });
  }
  return evidence.slice(0, 30);
}

export function calculateProductionIntelligence(snapshot = {}, options = {}) {
  const production = unwrap(snapshot.erp_active_production);
  const control = unwrap(snapshot.erp_business_control);
  const finance = unwrap(snapshot.erp_finance_summary);
  const productionRows = options.rows || rows(production);
  const lateRows = options.lateRows || rows(snapshot.erp_late_orders);
  const taskRows = options.taskRows || rows(snapshot.erp_list_employee_tasks);

  const planned = sum(productionRows, (item) => number(item.planned_quantity, item.planned, item.plan_qty, item.plan));
  const actual = sum(productionRows, (item) => number(item.actual_quantity, item.actual, item.output, item.produced_quantity));
  const samEarned = sum(productionRows, (item) => {
    const sam = number(item.sam_minutes, item.sam, item.smv);
    const produced = number(item.actual_quantity, item.actual, item.output, item.produced_quantity);
    return Number.isFinite(sam) && Number.isFinite(produced) ? sam * produced : null;
  });
  const availableMinutes = sum(productionRows, (item) => number(item.available_minutes, item.work_minutes, item.shift_minutes));
  const inspected = sum(productionRows, (item) => number(item.inspected_quantity, item.inspected, item.qc_checked));
  const firstPassGood = sum(productionRows, (item) => number(item.first_pass_good, item.good_first_pass, item.passed_first_time));
  const defects = sum(productionRows, (item) => number(item.defect_quantity, item.defects, item.rejected_quantity));
  const rework = sum(productionRows, (item) => number(item.rework_quantity, item.rework_qty, item.rework));
  const shipped = number(control.shipped_orders, control.shippedOrders, finance.shipped_orders);
  const onTime = number(control.on_time_orders, control.onTimeOrders, finance.on_time_orders);
  const downtimeMinutes = sum(productionRows, (item) => number(item.downtime_minutes, item.downtimeMinutes, item.stop_minutes));
  const planFact = percent(actual, planned);
  const efficiency = percent(samEarned, availableMinutes);
  const fpy = percent(firstPassGood, inspected);
  const otd = percent(onTime, shipped);
  const lateCount = number(unwrap(snapshot.erp_late_orders).total, unwrap(snapshot.erp_late_orders).count, lateRows.length);
  const sourceUpdatedAt = newest([...productionRows, ...lateRows, ...taskRows]);
  const sourceAgeMinutes = sourceUpdatedAt ? Math.max(0, round((Date.now() - Date.parse(sourceUpdatedAt)) / 60000, 0)) : null;

  const expected = [planned, actual, samEarned, availableMinutes, inspected, firstPassGood, shipped, onTime, sourceUpdatedAt];
  const completeness = round(expected.filter((value) => value !== null).length / expected.length * 100, 0);
  const missingData = [];
  if (!Number.isFinite(planned) || !Number.isFinite(actual)) missingData.push("план и фактический выпуск");
  if (!Number.isFinite(samEarned) || !Number.isFinite(availableMinutes)) missingData.push("SAM/SMV и доступные минуты");
  if (!Number.isFinite(inspected) || !Number.isFinite(firstPassGood)) missingData.push("результаты первичного контроля качества");
  if (!Number.isFinite(onTime) || !Number.isFinite(shipped)) missingData.push("факт своевременной отгрузки");
  if (!sourceUpdatedAt) missingData.push("время обновления источника");

  const causes = causeEvidence(productionRows, control);
  const confirmedCauses = causes.filter((item) => item.confirmed && item.reason);
  const confidence = completeness >= 80 && confirmedCauses.length ? "high" : completeness >= 50 ? "medium" : "low";
  const findings = [];
  if (Number.isFinite(planFact) && planFact < 95) findings.push({
    fact: `Выполнено ${planFact}% производственного плана (${actual} из ${planned}).`,
    deviation: round(planFact - 100),
    relatedData: { planned, actual, downtimeMinutes, lateOrders: lateCount },
    assumedReason: confirmedCauses[0]?.reason || null,
    confidence: confirmedCauses.length ? confidence : "low",
    missingData: confirmedCauses.length ? missingData : [...missingData, "подтверждённая причина отклонения"],
    updatedAt: sourceUpdatedAt,
    responsibility: null,
  });
  if (Number.isFinite(fpy) && fpy < 95) findings.push({
    fact: `First Pass Yield составляет ${fpy}% (${firstPassGood} из ${inspected}).`,
    deviation: round(fpy - 95),
    relatedData: { inspected, firstPassGood, defects, rework },
    assumedReason: null,
    confidence,
    missingData: [...missingData, "подтверждённая причина дефектов"],
    updatedAt: sourceUpdatedAt,
    responsibility: null,
  });

  return {
    generatedAt: new Date().toISOString(),
    scope: options.scope || { type: "factory", id: "all", name: "Компания" },
    metrics: {
      planned, actual, planFactPercent: planFact, efficiencySamPercent: efficiency,
      firstPassYieldPercent: fpy, defectQuantity: defects, reworkQuantity: rework,
      onTimeDeliveryPercent: otd, lateOrders: lateCount, downtimeMinutes,
      taskCount: taskRows.length,
    },
    quality: { completenessPercent: completeness, freshnessMinutes: sourceAgeMinutes, sourceUpdatedAt, missingData },
    causes,
    findings,
    rows: productionRows.slice(0, 250),
    tasks: taskRows.slice(0, 250),
  };
}

export class ProductionIntelligence {
  constructor({ databaseUrl = config.postgres.databaseUrl, bridge = erpBridge, pool = null, links = config.erp.accountLinks } = {}) {
    this.databaseUrl = databaseUrl;
    this.bridge = bridge;
    this.links = links || {};
    this.enabled = Boolean(databaseUrl);
    this.ownedPool = !pool && this.enabled;
    this.pool = pool || (this.enabled ? new Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 3000, statement_timeout: 8000 }) : null);
    this.ready = null;
    this.timer = null;
    this.last = null;
  }

  async init() {
    if (!this.enabled) return false;
    if (this.ready) return this.ready;
    this.ready = this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS mila_production;
      CREATE TABLE IF NOT EXISTS mila_production.sync_runs (
        id uuid PRIMARY KEY, started_at timestamptz NOT NULL, finished_at timestamptz,
        status text NOT NULL, source text NOT NULL DEFAULT 'erp-mcp', error text
      );
      CREATE TABLE IF NOT EXISTS mila_production.snapshots (
        id bigserial PRIMARY KEY, sync_id uuid NOT NULL REFERENCES mila_production.sync_runs(id),
        captured_at timestamptz NOT NULL DEFAULT now(), source_updated_at timestamptz,
        scope_type text NOT NULL, scope_id text NOT NULL, metrics jsonb NOT NULL,
        quality jsonb NOT NULL, details jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mila_production.decision_log (
        id bigserial PRIMARY KEY, sync_id uuid NOT NULL REFERENCES mila_production.sync_runs(id),
        created_at timestamptz NOT NULL DEFAULT now(), scope_type text NOT NULL,
        scope_id text NOT NULL, fact text NOT NULL, deviation numeric,
        assumed_reason text, confidence text NOT NULL, missing_data jsonb NOT NULL,
        source_updated_at timestamptz, evidence jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS production_snapshots_scope_time
        ON mila_production.snapshots(scope_type, scope_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS production_decisions_scope_time
        ON mila_production.decision_log(scope_type, scope_id, created_at DESC);
    `).then(() => true).catch((error) => { this.ready = null; throw error; });
    return this.ready;
  }

  async fetchSnapshot() {
    const entries = await Promise.all(TOOLS.map(async ([tool, args]) => [tool, await this.bridge.safeCall(tool, args)]));
    return Object.fromEntries(entries);
  }

  async sync() {
    if (!this.enabled) {
      const error = new Error("Production Intelligence requires PostgreSQL configuration");
      error.code = "production_postgres_not_configured";
      error.status = 503;
      throw error;
    }
    await this.init();
    const syncId = crypto.randomUUID();
    const startedAt = new Date();
    await this.pool.query("INSERT INTO mila_production.sync_runs(id, started_at, status) VALUES($1,$2,'running')", [syncId, startedAt]);
    try {
      const snapshot = await this.fetchSnapshot();
      const analysis = calculateProductionIntelligence(snapshot);
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO mila_production.snapshots(sync_id, source_updated_at, scope_type, scope_id, metrics, quality, details)
           VALUES($1,$2,'factory','all',$3::jsonb,$4::jsonb,$5::jsonb)`,
          [syncId, analysis.quality.sourceUpdatedAt, JSON.stringify(analysis.metrics), JSON.stringify(analysis.quality), JSON.stringify({ causes: analysis.causes, rows: analysis.rows, tasks: analysis.tasks })],
        );
        for (const finding of analysis.findings) await client.query(
          `INSERT INTO mila_production.decision_log(sync_id, scope_type, scope_id, fact, deviation, assumed_reason, confidence, missing_data, source_updated_at, evidence)
           VALUES($1,'factory','all',$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)`,
          [syncId, finding.fact, finding.deviation, finding.assumedReason, finding.confidence, JSON.stringify(finding.missingData), finding.updatedAt, JSON.stringify(finding.relatedData)],
        );
        await client.query("UPDATE mila_production.sync_runs SET status='success', finished_at=now() WHERE id=$1", [syncId]);
        await client.query("DELETE FROM mila_production.snapshots WHERE captured_at < now() - interval '400 days'");
        await client.query("DELETE FROM mila_production.decision_log WHERE created_at < now() - interval '400 days'");
        await client.query("DELETE FROM mila_production.sync_runs WHERE finished_at < now() - interval '400 days'");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      this.last = { at: Date.now(), snapshot, analysis };
      return analysis;
    } catch (error) {
      await this.pool.query("UPDATE mila_production.sync_runs SET status='error', finished_at=now(), error=$2 WHERE id=$1", [syncId, clean(error.message, 400)]).catch(() => {});
      throw error;
    }
  }

  async latest() {
    await this.init();
    const result = await this.pool.query(
      `SELECT captured_at, source_updated_at, metrics, quality, details
       FROM mila_production.snapshots WHERE scope_type='factory' AND scope_id='all'
       ORDER BY captured_at DESC LIMIT 1`,
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return { generatedAt: row.captured_at, scope: { type: "factory", id: "all", name: "Компания" }, metrics: row.metrics, quality: row.quality, ...row.details };
  }

  async dashboard(user, { force = false } = {}) {
    const executive = EXECUTIVE_ROLES.has(user?.role);
    if (executive) {
      if (!this.enabled) return {
        ok: false, access: "company", code: "production_postgres_not_configured",
        message: "Production Intelligence не настроен: отсутствует подключение PostgreSQL.",
      };
      const analysis = force ? await this.sync() : await this.latest() || await this.sync();
      return { ok: true, access: "company", ...analysis };
    }
    const identity = accountIdentity(user, this.links);
    if (!identity.configured) return {
      ok: false, access: "own", code: "erp_identity_not_linked",
      message: "Ваш аккаунт пока не связан с сотрудником ERP. Обратитесь к руководителю.",
    };
    const taskResult = await this.bridge.safeCall("erp_list_employee_tasks", {
      employee: identity.configuredLink.employeeId,
      limit: 100,
    });
    const taskRows = ownedRows(rows(taskResult), identity);
    return {
      ok: true, access: "own", generatedAt: new Date().toISOString(),
      scope: { type: "employee", id: user.id, name: user.name },
      metrics: { taskCount: taskRows.length }, tasks: taskRows,
      quality: { completenessPercent: taskResult?.ok === false ? 0 : 100, freshnessMinutes: null, sourceUpdatedAt: newest(taskRows), missingData: [] },
      findings: [], causes: [], rows: [],
    };
  }

  start(intervalMs = config.production.syncIntervalMs) {
    if (!this.enabled || this.timer) return;
    const run = () => this.sync().catch((error) => console.warn(`[production] ${clean(error.message, 240)}`))
      .finally(() => { this.timer = setTimeout(run, intervalMs); });
    this.timer = setTimeout(run, 15_000);
  }

  async stop() {
    clearTimeout(this.timer); this.timer = null;
    if (this.ownedPool) await this.pool.end();
  }
}

export const productionIntelligence = new ProductionIntelligence();
