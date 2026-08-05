import { api } from "../api.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { esc, toast } from "../ui.js";

let snapshot = null;
let loading = true;
let error = "";

const nf = new Intl.NumberFormat();
const money = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

const pretty = (value, fallback = "-") => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return nf.format(value);
  return String(value);
};

const objectText = (value) => {
  if (value === undefined || value === null) return "-";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
};

const unwrap = (value) => {
  if (!value || typeof value !== "object") return value;
  if ("data" in value && Object.keys(value).length <= 3) return unwrap(value.data);
  return value;
};

const asArray = (value, keys = ["items", "orders", "tasks", "rows", "results", "data"]) => {
  const data = unwrap(value);
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of keys) {
    const next = data[key];
    if (Array.isArray(next)) return next;
    if (next && typeof next === "object" && Array.isArray(next.items)) return next.items;
  }
  return [];
};

const first = (obj, keys, fallback = "-") => {
  const data = unwrap(obj);
  for (const key of keys) {
    const value = data?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
};

const numeric = (obj, keys, fallback = 0) => {
  const value = first(obj, keys, null);
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const countish = (obj, keys, arrayFallback = []) => {
  const found = first(obj, keys, null);
  if (found !== null) {
    const n = Number(found);
    if (Number.isFinite(n)) return n;
  }
  return arrayFallback.length;
};

function head() {
  return `<div class="page-head">
    <div><h1>${t("erp.title")}</h1><p>${t("erp.subtitle")}</p></div>
    <div class="spacer"></div>
    <button class="btn btn-secondary" id="erpWikiSync">${icon("knowledge")}Sync wiki</button>
    <button class="btn btn-secondary" id="erpRefresh">${icon("refresh")}${t("erp.refresh")}</button>
  </div>`;
}

function metric(label, value, hint = "", tone = "") {
  return `<div class="studio-metric erp-metric ${tone}"><span>${esc(label)}</span><strong>${esc(pretty(value))}</strong>${hint ? `<small>${esc(hint)}</small>` : ""}</div>`;
}

function card(title, subtitle, body, iconName = "activity", extra = "") {
  return `<section class="card ${extra}">
    <div class="row gap-2 mb-3"><span class="aico">${icon(iconName)}</span><div><h3>${esc(title)}</h3>${subtitle ? `<p class="muted">${esc(subtitle)}</p>` : ""}</div></div>
    ${body}
  </section>`;
}

function empty(label = t("erp.empty")) {
  return `<div class="empty compact"><p>${esc(label)}</p></div>`;
}

function kv(data, rows) {
  const body = rows.map(([label, value, tone = ""]) => `<div class="${tone}"><span>${esc(label)}</span><strong>${esc(pretty(value))}</strong></div>`).join("");
  return `<div class="kv-grid">${body}</div>${data ? `<details class="erp-raw"><summary>${esc(t("erp.raw"))}</summary><pre class="codebox">${esc(objectText(data))}</pre></details>` : ""}`;
}

function table(headers, rows, emptyLabel = t("erp.empty")) {
  if (!rows.length) return empty(emptyLabel);
  return `<div class="table-wrap erp-table"><table class="tbl"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function toolsHTML() {
  const tools = snapshot?.server?.tools || [];
  if (!tools.length) return `<p class="muted">${t("erp.noTools")}</p>`;
  return `<div class="chips">${tools.map((tool) => `<span class="badge neutral">${esc(tool.name)}</span>`).join("")}</div>`;
}

function statusBadge(value) {
  const cls = value === "active" || value === "ready" || value === true ? "success" : value === "error" ? "error" : "warning";
  return `<span class="badge ${cls}"><span class="dot"></span>${esc(pretty(value))}</span>`;
}

function inventoryTable(inventory) {
  const items = asArray(inventory);
  const sorted = [...items].sort((a, b) => numeric(a, ["available_quantity", "available", "quantity", "qty"]) - numeric(b, ["available_quantity", "available", "quantity", "qty"]));
  return table(
    [t("erp.sku"), t("erp.item"), t("erp.category"), t("erp.available"), t("erp.reserved")],
    sorted.slice(0, 14).map((item) => {
      const available = numeric(item, ["available_quantity", "available", "quantity", "qty"]);
      const reserved = numeric(item, ["reserved_quantity", "reserved"], 0);
      const low = available > 0 && available < 20;
      return `<tr class="${low ? "risk" : ""}">
        <td><strong>${esc(first(item, ["sku", "code", "item_id", "id"]))}</strong></td>
        <td><strong>${esc(first(item, ["name", "title"]))}</strong><small>${esc(first(item, ["unit"], ""))}</small></td>
        <td>${esc(first(item, ["category", "group"], "-"))}</td>
        <td><span class="badge ${low ? "warning" : "success"}">${esc(pretty(available))}</span></td>
        <td>${esc(pretty(reserved))}</td>
      </tr>`;
    })
  );
}

function finishedGoodsTable(finishedGoods) {
  const models = asArray(first(finishedGoods, ["top_models", "topModels"], []));
  return table(
    [t("erp.model"), t("erp.item"), t("erp.order"), t("erp.color"), t("erp.finishedGoodsPieces"), t("erp.finishedGoodsPackages"), t("erp.location"), t("erp.status")],
    models.slice(0, 12).map((item) => {
      const sections = asArray(first(item, ["sections"], [])).join(", ");
      const sample = asArray(first(item, ["sample_rows", "sampleRows"], []))[0] || {};
      const location = [
        sections ? `${t("erp.section")}: ${sections}` : "",
        first(sample, ["cell"], "") ? `${t("erp.cell")}: ${first(sample, ["cell"], "")}` : "",
        first(sample, ["shelf"], "") ? `${t("erp.shelf")}: ${first(sample, ["shelf"], "")}` : "",
      ].filter(Boolean).join(" / ");
      return `<tr>
        <td><strong>${esc(first(item, ["model_code", "modelCode"], "-"))}</strong><small>${esc(first(item, ["sizes"], "") ? objectText(first(item, ["sizes"], {})) : "")}</small></td>
        <td><strong>${esc(first(item, ["model_name", "modelName"], "-"))}</strong></td>
        <td>${esc(first(item, ["order_no", "orderNo"], "-"))}</td>
        <td>${esc(first(item, ["color"], "-"))}</td>
        <td><span class="badge success">${esc(pretty(first(item, ["total_pieces", "totalPieces"], 0)))}</span></td>
        <td>${esc(pretty(first(item, ["packages"], 0)))}</td>
        <td>${esc(location || "-")}</td>
        <td>${statusBadge(Object.keys(first(item, ["statuses"], {}))[0] || first(sample, ["status"], "-"))}</td>
      </tr>`;
    })
  );
}

function productionTable(production) {
  const rows = asArray(production, ["items", "orders", "active_orders", "rows", "data"]);
  const data = unwrap(production) || {};
  if (!rows.length && data && typeof data === "object") {
    const stages = [
      [t("erp.cutting"), first(data, ["cutting_output", "cuttingOutput"], 0)],
      [t("erp.printing"), first(data, ["printing_output", "printingOutput"], 0)],
      [t("erp.sewing"), first(data, ["sewing_output", "sewingOutput"], 0)],
      [t("erp.packaging"), first(data, ["packaging_output", "packagingOutput"], 0)],
      [t("erp.rework"), first(data, ["rework_qty", "reworkQty"], 0)],
    ].filter(([, value]) => Number(value) || value === 0);
    if (stages.length) {
      return table(
        [t("erp.stage"), t("erp.output"), t("erp.status")],
        stages.map(([label, value]) => `<tr>
          <td><strong>${esc(label)}</strong></td>
          <td>${esc(pretty(value))}</td>
          <td>${statusBadge(Number(value) > 0 ? "active" : "idle")}</td>
        </tr>`)
      );
    }
  }
  return table(
    [t("erp.order"), t("erp.stage"), t("erp.deadline"), t("erp.owner"), t("erp.status")],
    rows.slice(0, 12).map((item) => `<tr>
      <td><strong>${esc(first(item, ["order", "order_number", "orderNumber", "id", "title"]))}</strong><small>${esc(first(item, ["model", "style", "sku"], ""))}</small></td>
      <td>${esc(first(item, ["stage", "step", "phase"], "-"))}</td>
      <td>${esc(first(item, ["deadline", "due_date", "dueDate"], "-"))}</td>
      <td>${esc(first(item, ["owner", "responsible", "employee"], "-"))}</td>
      <td>${statusBadge(first(item, ["status", "state"], "active"))}</td>
    </tr>`)
  );
}

function lateOrdersTable(late) {
  const rows = asArray(late, ["items", "orders", "late_orders", "data"]);
  return table(
    [t("erp.order"), t("erp.deadline"), t("erp.daysLate"), t("erp.reason")],
    rows.slice(0, 12).map((item) => `<tr class="risk">
      <td><strong>${esc(first(item, ["order", "order_number", "orderNumber", "id", "title"]))}</strong></td>
      <td>${esc(first(item, ["deadline", "due_date", "dueDate"], "-"))}</td>
      <td><span class="badge error">${esc(pretty(first(item, ["days_late", "daysLate", "late_days"], "-")))}</span></td>
      <td>${esc(first(item, ["reason", "blocker", "status", "stage"], "-"))}</td>
    </tr>`)
  );
}

function flowLoadTable(control) {
  const rows = asArray(first(control, ["busiest_sewing_flows"], []));
  return table(
    [t("erp.flow"), t("erp.orders"), t("erp.plannedQty"), t("erp.inProgress"), t("erp.blocked")],
    rows.slice(0, 10).map((item) => `<tr>
      <td><strong>${esc(first(item, ["flow", "name", "code"]))}</strong></td>
      <td>${esc(pretty(first(item, ["orders"], 0)))}</td>
      <td>${esc(pretty(first(item, ["planned_quantity", "plannedQuantity"], 0)))}</td>
      <td>${esc(pretty(first(item, ["in_progress", "inProgress"], 0)))}</td>
      <td>${statusBadge(first(item, ["blocked"], 0))}</td>
    </tr>`)
  );
}

function warehouseEtaTable(control) {
  const rows = asArray(first(control, ["warehouse_eta", "warehouseEta"], []));
  return table(
    [t("erp.order"), t("erp.model"), t("erp.qty"), t("erp.warehouseEta"), t("erp.status")],
    rows.slice(0, 12).map((item) => `<tr class="${item.warehouse_overdue ? "risk" : ""}">
      <td><strong>${esc(first(item, ["production_no", "productionNo", "order_no", "orderNo"]))}</strong><small>${esc(first(item, ["order_no", "orderNo"], ""))}</small></td>
      <td>${esc(first(item, ["model_code", "modelCode"], "-"))}<small>${esc(first(item, ["model_name", "modelName"], ""))}</small></td>
      <td>${esc(pretty(first(item, ["planned_quantity", "plannedQuantity"], 0)))}</td>
      <td>${esc(first(item, ["warehouse_eta", "warehouseEta"], "-"))}</td>
      <td>${statusBadge(first(item, ["warehouse_status", "warehouseStatus"], "-"))}</td>
    </tr>`)
  );
}

function stageLoadTable(control) {
  const rows = asArray(first(control, ["stage_summary", "stageSummary"], []));
  return table(
    [t("erp.stage"), t("erp.orders"), t("erp.plannedQty"), t("erp.actualQty")],
    rows.slice(0, 10).map((item) => `<tr>
      <td><strong>${esc(first(item, ["stage"], "-"))}</strong></td>
      <td>${esc(pretty(first(item, ["orders"], 0)))}</td>
      <td>${esc(pretty(first(item, ["planned_quantity", "plannedQuantity"], 0)))}</td>
      <td>${esc(pretty(first(item, ["actual_quantity", "actualQuantity"], 0)))}</td>
    </tr>`)
  );
}

function tasksTable(tasks) {
  const rows = asArray(tasks, ["items", "tasks", "rows", "data"]);
  return table(
    [t("erp.task"), t("erp.owner"), t("erp.deadline"), t("erp.status")],
    rows.slice(0, 12).map((item) => `<tr>
      <td><strong>${esc(first(item, ["title", "name", "task", "id"]))}</strong><small>${esc(first(item, ["summary", "description"], ""))}</small></td>
      <td>${esc(first(item, ["employee", "owner", "assignee"], "-"))}</td>
      <td>${esc(first(item, ["deadline", "due_date", "dueDate"], "-"))}</td>
      <td>${statusBadge(first(item, ["status", "state"], "-"))}</td>
    </tr>`)
  );
}

function searchResults(value) {
  const data = unwrap(value);
  const rows = asArray(data, ["items", "results", "rows", "data"]);
  if (rows.length) {
    return table([t("erp.result"), t("erp.type"), t("erp.status")], rows.slice(0, 12).map((item) => `<tr>
      <td><strong>${esc(first(item, ["title", "name", "order", "sku", "id"]))}</strong><small>${esc(first(item, ["summary", "description"], ""))}</small></td>
      <td>${esc(first(item, ["type", "category", "entity"], "-"))}</td>
      <td>${esc(first(item, ["status", "state"], "-"))}</td>
    </tr>`));
  }
  return `<pre class="codebox">${esc(objectText(data))}</pre>`;
}

function quickActions() {
  const prompts = [
    ["summary", t("erp.actionSummary"), "Мила, сделай короткую бизнес-сводку ERP: продажи, производство, склад, риски и следующий шаг."],
    ["flow", t("erp.actionFlow"), "Мила, какой швейный поток сейчас самый загруженный? Назови поток, количество заказов, плановое количество и риск."],
    ["warehouse", t("erp.actionWarehouse"), "Мила, какие заказы быстрее всего дойдут до склада и где есть риск задержки?"],
    ["ready", t("erp.actionReadyGoods"), "Мила, что сейчас есть на складе готовых изделий? Ответь только по ERP finished_goods_stock из /warehouse-stock и /warehouse-map: модель, название, заказ, цвет, упаковки, штуки и место хранения. Не используй выпуск производства."],
    ["inventory", t("erp.actionInventory"), "Мила, проанализируй склад ERP: что в риске, какие позиции проверить, что нужно докупить или зарезервировать."],
    ["late", t("erp.actionLate"), "Мила, проверь просроченные ERP-заказы и предложи план действий для Hermes Kanban."],
  ];
  return `<div class="erp-actions">${prompts.map(([key, label, prompt]) => `<button class="btn btn-secondary" data-erp-prompt="${esc(prompt)}">${icon(key === "late" ? "warn" : key === "inventory" || key === "ready" ? "knowledge" : key === "warehouse" ? "workflow" : "mic")}${esc(label)}</button>`).join("")}</div>`;
}

function erpHTML() {
  if (!api.on) return `<div class="page">${head()}<div class="card">${t("erp.demo")}</div></div>`;
  if (loading) return `<div class="page">${head()}<div class="card">${t("erp.loading")}</div></div>`;
  if (error) return `<div class="page">${head()}<div class="alert error"><div class="a-body"><div class="a-title">${t("erp.unavailable")}</div><div class="a-text">${esc(error)}</div></div></div></div>`;

  const cards = snapshot.cards || {};
  const errors = snapshot.errors || {};
  const summary = unwrap(cards.erp_gm_summary) || {};
  const production = unwrap(cards.erp_active_production) || {};
  const control = unwrap(cards.erp_business_control) || {};
  const late = unwrap(cards.erp_late_orders);
  const inventory = unwrap(cards.erp_inventory_status) || {};
  const finishedGoods = unwrap(cards.erp_finished_goods_stock) || {};
  const finance = unwrap(cards.erp_finance_summary) || {};
  const tasks = unwrap(cards.erp_list_employee_tasks);
  const me = unwrap(cards.erp_me) || {};

  const invItems = asArray(inventory);
  const readyModels = asArray(first(finishedGoods, ["top_models", "topModels"], []));
  const lateItems = asArray(late);
  const taskItems = asArray(tasks);
  const productionItems = asArray(production, ["items", "orders", "active_orders", "rows", "data"]);
  const revenue = numeric(summary, ["revenue_total", "revenue", "sales", "totalSales"], numeric(finance, ["revenue_total", "revenue"]));
  const stockValue = numeric(summary, ["branded_stock_value", "stock_value"], numeric(finance, ["branded_stock_value", "stock_value"]));
  const activeOrders = countish(summary, ["active_orders", "activeOrders", "orders"], productionItems) || numeric(production, ["active_work_orders", "activeWorkOrders"], 0);
  const lateOrders = countish(summary, ["late_orders", "lateOrders"], lateItems);
  const cuttingOutput = numeric(production, ["cutting_output", "cuttingOutput"], 0);
  const printingOutput = numeric(production, ["printing_output", "printingOutput"], 0);
  const sewingOutput = numeric(production, ["sewing_output", "sewingOutput"], 0);
  const packagingOutput = numeric(production, ["packaging_output", "packagingOutput"], 0);
  const stagedProductionOutput = cuttingOutput + printingOutput + sewingOutput + packagingOutput;
  const productionOutput = numeric(production, ["production_output", "productionOutput", "total_output", "totalOutput"], stagedProductionOutput);
  const reworkQty = numeric(production, ["rework_qty", "reworkQty"], 0);
  const totalTrackedOrders = numeric(control, ["total_orders", "totalOrders"], 0);
  const blockedOrders = asArray(first(control, ["blocked_orders", "blockedOrders"], []));
  const busiestFlow = first(first(control, ["answer_hints", "answerHints"], {}), ["busiest_sewing_flow", "busiestSewingFlow"], null);
  const nextWarehouse = first(first(control, ["answer_hints", "answerHints"], {}), ["next_warehouse_order", "nextWarehouseOrder"], null);
  const readyPieces = numeric(finishedGoods, ["total_pieces", "totalPieces"], 0);
  const readyPackages = numeric(finishedGoods, ["total_packages", "totalPackages"], 0);
  const readyModelsCount = numeric(finishedGoods, ["total_models", "totalModels"], readyModels.length);

  return `<div class="page erp-page">
    ${head()}
    ${!snapshot.configured ? `<div class="alert warning mb-4"><span class="a-ico">${icon("warn")}</span><div class="a-body"><div class="a-title">${t("erp.tokenMissing")}</div><div class="a-text">${t("erp.tokenMissingText")}</div></div></div>` : ""}
    ${Object.keys(errors).length ? `<div class="alert warning mb-4"><span class="a-ico">${icon("warn")}</span><div class="a-body"><div class="a-title">${t("erp.partial")}</div><div class="a-text">${esc(Object.entries(errors).map(([key, value]) => `${key}: ${value}`).join(" | "))}</div></div></div>` : ""}
    <div class="grid cols-4 mb-4">
      ${metric(t("erp.connection"), snapshot.server?.status || "stopped", snapshot.baseUrl, "ok")}
      ${metric(t("erp.revenue"), revenue ? money.format(revenue) : 0, t("erp.sales"), revenue ? "ok" : "")}
      ${metric(t("erp.productionOutput"), productionOutput, t("erp.production"), productionOutput ? "ok" : "")}
      ${metric(t("erp.lateOrders"), lateOrders, t("erp.needsAttention"), lateOrders ? "risk" : "ok")}
    </div>
    <div class="grid cols-4 mb-4">
      ${metric(t("erp.finishedGoodsPieces"), readyPieces, t("erp.finishedGoods"), readyPieces ? "ok" : "")}
      ${metric(t("erp.activeOrders"), activeOrders, t("erp.production"), activeOrders ? "ok" : "")}
      ${metric(t("erp.sewing"), sewingOutput, t("erp.production"), sewingOutput ? "ok" : "")}
      ${metric(t("erp.packaging"), packagingOutput, t("erp.production"), packagingOutput ? "ok" : "")}
    </div>
    <div class="grid cols-4 mb-4">
      ${metric(t("erp.stockValue"), stockValue ? money.format(stockValue) : 0, t("erp.finance"), stockValue ? "ok" : "")}
      ${metric(t("erp.employeeTasks"), taskItems.length, t("erp.tasks"), taskItems.length ? "warning" : "ok")}
      ${metric(t("erp.rework"), reworkQty, t("erp.needsAttention"), reworkQty ? "risk" : "ok")}
      ${metric(t("erp.tools"), snapshot.server?.tools?.length || 0, "MCP", "ok")}
    </div>
    <div class="grid cols-4 mb-4">
      ${metric(t("erp.finishedGoodsPackages"), readyPackages, t("erp.finishedGoods"), readyPackages ? "ok" : "")}
      ${metric(t("erp.finishedGoodsModels"), readyModelsCount, t("erp.finishedGoods"), readyModelsCount ? "ok" : "")}
      ${metric(t("erp.materialInventory"), invItems.length, t("erp.inventory"), invItems.length ? "ok" : "")}
      ${metric(t("erp.source"), finishedGoods.source_page || finishedGoods.source || "-", "/warehouse-stock + /warehouse-map", finishedGoods.source ? "ok" : "")}
    </div>
    <div class="grid cols-4 mb-4">
      ${metric(t("erp.trackedOrders"), totalTrackedOrders, t("erp.processTracking"), totalTrackedOrders ? "ok" : "")}
      ${metric(t("erp.busiestFlow"), busiestFlow ? first(busiestFlow, ["flow"]) : "-", busiestFlow ? `${pretty(first(busiestFlow, ["planned_quantity"], 0))} ${t("erp.qtyShort")}` : t("erp.noData"), busiestFlow ? "warning" : "")}
      ${metric(t("erp.nextWarehouse"), nextWarehouse ? first(nextWarehouse, ["production_no", "order_no"], "-") : "-", nextWarehouse ? first(nextWarehouse, ["warehouse_eta"], "-") : t("erp.noData"), nextWarehouse ? "ok" : "")}
      ${metric(t("erp.blockedOrders"), blockedOrders.length, t("erp.needsAttention"), blockedOrders.length ? "risk" : "ok")}
    </div>
    ${card(t("erp.quickActions"), t("erp.quickActionsHint"), quickActions(), "zap", "mb-4")}
    <div class="grid cols-2 mb-4">
      ${card(t("erp.gmSummary"), t("erp.gmSummaryHint"), kv(summary, [
        [t("erp.activeOrders"), activeOrders],
        [t("erp.productionOutput"), productionOutput],
        [t("erp.sewing"), sewingOutput],
        [t("erp.packaging"), packagingOutput],
        [t("erp.lateOrders"), lateOrders],
        [t("erp.defects"), first(summary, ["todays_defects", "defects"], 0)],
        [t("erp.waste"), first(summary, ["todays_waste", "waste"], 0)],
        [t("erp.stockValue"), stockValue],
        [t("erp.revenue"), revenue],
      ]), "activity")}
      ${card(t("erp.finance"), t("erp.financeHint"), kv(finance, [
        [t("erp.revenue"), first(finance, ["revenue_total", "revenue"], 0)],
        [t("erp.payments"), first(finance, ["payments_received", "payments"], 0)],
        [t("erp.stockValue"), first(finance, ["branded_stock_value", "stock_value"], 0)],
        [t("erp.wasteCost"), first(finance, ["waste_cost", "waste"], 0)],
        [t("erp.wasteIncome"), first(finance, ["waste_income"], 0)],
        [t("erp.profit"), first(finance, ["profit"], 0)],
      ]), "database")}
      ${card(t("erp.productionStatus"), t("erp.productionHint"), productionTable(production), "workflow")}
      ${card(t("erp.lateOrders"), t("erp.lateOrdersHint"), lateOrdersTable(late), "warn")}
      ${card(t("erp.flowLoad"), t("erp.flowLoadHint"), flowLoadTable(control), "agents")}
      ${card(t("erp.warehouseEta"), t("erp.warehouseEtaHint"), warehouseEtaTable(control), "workflow")}
      ${card(t("erp.stageLoad"), t("erp.stageLoadHint"), stageLoadTable(control), "activity")}
      ${card(t("erp.finishedGoods"), t("erp.finishedGoodsHint"), finishedGoodsTable(finishedGoods), "knowledge")}
      ${card(t("erp.materialInventory"), t("erp.materialInventoryHint"), inventoryTable(inventory), "database")}
      ${card(t("erp.employeeTasks"), t("erp.employeeTasksHint"), tasksTable(tasks), "agents")}
    </div>
    <div class="grid cols-2">
      ${card(t("erp.search"), t("erp.searchHint"), `<div class="row gap-2"><input class="input" id="erpSearchInput" placeholder="${esc(t("erp.searchPlaceholder"))}"/><button class="btn btn-primary" id="erpSearchBtn">${icon("search")}${t("erp.runSearch")}</button></div><div id="erpSearchResult" class="mt-3"></div>`, "search")}
      ${card(t("erp.mcpAccess"), t("erp.mcpAccessHint"), `<div class="mb-3">${statusBadge(snapshot.server?.status || "stopped")}</div>${toolsHTML()}<div class="row gap-2 mt-3"><a class="btn btn-secondary" href="#/mcp">${icon("mcp")}${t("erp.openMcp")}</a><a class="btn btn-secondary" href="#/mila">${icon("mic")}${t("erp.askMila")}</a></div><details class="erp-raw mt-3"><summary>${esc(t("erp.currentUser"))}</summary><pre class="codebox">${esc(objectText(me))}</pre></details>`, "mcp")}
    </div>
  </div>`;
}

async function load(root) {
  loading = true;
  error = "";
  root.innerHTML = erpHTML();
  try {
    snapshot = await api.erp.snapshot();
  } catch (err) {
    error = err.message || String(err);
  } finally {
    loading = false;
    root.innerHTML = erpHTML();
    bind(root);
  }
}

function bind(root) {
  root.querySelector("#erpRefresh")?.addEventListener("click", () => load(root));
  root.querySelector("#erpWikiSync")?.addEventListener("click", async () => {
    try {
      const result = await api.erp.wikiSync();
      toast("success", "ERP wiki", `${result.notes?.length || 0} Obsidian notes updated`);
    } catch (err) {
      toast("error", "ERP wiki", err.message);
    }
  });
  root.querySelectorAll("[data-erp-prompt]").forEach((button) => {
    button.addEventListener("click", async () => {
      const prompt = button.dataset.erpPrompt || "";
      try { await navigator.clipboard.writeText(prompt); toast("success", t("erp.promptCopied"), t("erp.promptCopiedHint")); }
      catch { toast("info", t("erp.promptReady"), prompt); }
    });
  });
  root.querySelector("#erpSearchBtn")?.addEventListener("click", async () => {
    const input = root.querySelector("#erpSearchInput");
    const result = root.querySelector("#erpSearchResult");
    const query = input?.value?.trim();
    if (!query) return;
    result.innerHTML = `<div class="card">${t("erp.searching")}</div>`;
    try {
      const response = await api.erp.tool("erp_search", { query, limit: 10 });
      result.innerHTML = searchResults(response.result?.data || response.result);
    } catch (err) {
      toast("error", t("erp.searchFailed"), err.message);
      result.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
    }
  });
}

export default {
  title: "ERP",
  render: erpHTML,
  mount: load,
};
