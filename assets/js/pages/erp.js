import { api } from "../api.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { esc, toast } from "../ui.js";

let snapshot = null;
let loading = true;
let error = "";

const pretty = (value) => {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "number") return new Intl.NumberFormat().format(value);
  return String(value);
};
const objectText = (value) => {
  if (value === undefined || value === null) return "-";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
};
const first = (obj, keys, fallback = "-") => {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
};

function head() {
  return `<div class="page-head">
    <div><h1>${t("erp.title")}</h1><p>${t("erp.subtitle")}</p></div>
    <div class="spacer"></div>
    <button class="btn btn-secondary" id="erpRefresh">${icon("refresh")}${t("erp.refresh")}</button>
  </div>`;
}

function metric(label, value, hint = "") {
  return `<div class="studio-metric"><span>${esc(label)}</span><strong>${esc(pretty(value))}</strong>${hint ? `<small>${esc(hint)}</small>` : ""}</div>`;
}

function card(title, subtitle, body, iconName = "activity") {
  return `<section class="card">
    <div class="row gap-2 mb-3"><span class="aico">${icon(iconName)}</span><div><h3>${esc(title)}</h3>${subtitle ? `<p class="muted">${esc(subtitle)}</p>` : ""}</div></div>
    ${body}
  </section>`;
}

function list(items, empty = t("erp.empty")) {
  if (!Array.isArray(items) || !items.length) return `<div class="empty compact"><p>${esc(empty)}</p></div>`;
  return `<div class="list compact">${items.slice(0, 8).map((item) => {
    const title = first(item, ["title", "name", "order", "orderNumber", "employee", "sku", "id"]);
    const hint = first(item, ["status", "stage", "dueDate", "deadline", "department", "summary"], "");
    const value = first(item, ["amount", "total", "qty", "quantity", "daysLate"], "");
    return `<div class="list-item"><div><strong>${esc(title)}</strong>${hint ? `<p class="muted">${esc(hint)}</p>` : ""}</div>${value ? `<span class="badge neutral">${esc(pretty(value))}</span>` : ""}</div>`;
  }).join("")}</div>`;
}

function dataPanel(data, preferredKeys = []) {
  if (Array.isArray(data)) return list(data);
  if (!data || typeof data !== "object") return `<pre class="codebox">${esc(objectText(data))}</pre>`;
  const rows = preferredKeys
    .map(([label, key]) => [label, data[key]])
    .filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!rows.length) return `<pre class="codebox">${esc(objectText(data))}</pre>`;
  return `<div class="kv-grid">${rows.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(pretty(value))}</strong></div>`).join("")}</div>`;
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

function erpHTML() {
  if (!api.on) return `<div class="page">${head()}<div class="card">${t("erp.demo")}</div></div>`;
  if (loading) return `<div class="page">${head()}<div class="card">${t("erp.loading")}</div></div>`;
  if (error) return `<div class="page">${head()}<div class="alert error"><div class="a-body"><div class="a-title">${t("erp.unavailable")}</div><div class="a-text">${esc(error)}</div></div></div></div>`;

  const cards = snapshot.cards || {};
  const errors = snapshot.errors || {};
  const summary = cards.erp_gm_summary || {};
  const production = cards.erp_active_production || {};
  const late = cards.erp_late_orders;
  const inventory = cards.erp_inventory_status || {};
  const finance = cards.erp_finance_summary || {};
  const tasks = cards.erp_list_employee_tasks;
  const me = cards.erp_me || {};

  return `<div class="page erp-page">
    ${head()}
    ${!snapshot.configured ? `<div class="alert warning mb-4"><span class="a-ico">${icon("warn")}</span><div class="a-body"><div class="a-title">${t("erp.tokenMissing")}</div><div class="a-text">${t("erp.tokenMissingText")}</div></div></div>` : ""}
    ${Object.keys(errors).length ? `<div class="alert warning mb-4"><span class="a-ico">${icon("warn")}</span><div class="a-body"><div class="a-title">${t("erp.partial")}</div><div class="a-text">${esc(Object.entries(errors).map(([key, value]) => `${key}: ${value}`).join(" | "))}</div></div></div>` : ""}
    <div class="grid cols-4 mb-4">
      ${metric(t("erp.connection"), snapshot.server?.status || "stopped", snapshot.baseUrl)}
      ${metric(t("erp.tools"), snapshot.server?.tools?.length || 0, "MCP")}
      ${metric(t("erp.sales"), first(summary, ["sales", "revenue", "totalSales"]))}
      ${metric(t("erp.production"), first(production, ["active", "activeOrders", "orders", "count"]))}
    </div>
    <div class="grid cols-2 mb-4">
      ${card(t("erp.gmSummary"), t("erp.gmSummaryHint"), dataPanel(summary, [[t("erp.revenue"), "revenue"], [t("erp.orders"), "orders"], [t("erp.margin"), "margin"], [t("erp.alerts"), "alerts"]]), "activity")}
      ${card(t("erp.productionStatus"), t("erp.productionHint"), dataPanel(production, [[t("erp.activeOrders"), "activeOrders"], [t("erp.blockers"), "blockers"], [t("erp.onTime"), "onTime"], [t("erp.load"), "load"]]), "workflow")}
      ${card(t("erp.lateOrders"), t("erp.lateOrdersHint"), list(Array.isArray(late) ? late : late?.items || late?.orders || []), "warn")}
      ${card(t("erp.inventory"), t("erp.inventoryHint"), dataPanel(inventory, [[t("erp.stockRisk"), "stockRisk"], [t("erp.lowStock"), "lowStock"], [t("erp.fastMoving"), "fastMoving"], [t("erp.totalSku"), "totalSku"]]), "knowledge")}
      ${card(t("erp.finance"), t("erp.financeHint"), dataPanel(finance, [[t("erp.revenue"), "revenue"], [t("erp.expense"), "expense"], [t("erp.profit"), "profit"], [t("erp.cashflow"), "cashflow"]]), "database")}
      ${card(t("erp.employeeTasks"), t("erp.employeeTasksHint"), list(Array.isArray(tasks) ? tasks : tasks?.items || tasks?.tasks || []), "agents")}
    </div>
    <div class="grid cols-2">
      ${card(t("erp.search"), t("erp.searchHint"), `<div class="row gap-2"><input class="input" id="erpSearchInput" placeholder="${esc(t("erp.searchPlaceholder"))}"/><button class="btn btn-primary" id="erpSearchBtn">${icon("search")}${t("erp.runSearch")}</button></div><div id="erpSearchResult" class="mt-3"></div>`, "search")}
      ${card(t("erp.mcpAccess"), t("erp.mcpAccessHint"), `<div class="mb-3">${statusBadge(snapshot.server?.status || "stopped")}</div>${toolsHTML()}<div class="row gap-2 mt-3"><a class="btn btn-secondary" href="#/mcp">${icon("mcp")}${t("erp.openMcp")}</a><a class="btn btn-secondary" href="#/mila">${icon("mic")}${t("erp.askMila")}</a></div><pre class="codebox mt-3">${esc(objectText(me))}</pre>`, "mcp")}
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
  root.querySelector("#erpSearchBtn")?.addEventListener("click", async () => {
    const input = root.querySelector("#erpSearchInput");
    const result = root.querySelector("#erpSearchResult");
    const query = input?.value?.trim();
    if (!query) return;
    result.innerHTML = `<div class="card">${t("erp.searching")}</div>`;
    try {
      const response = await api.erp.tool("erp_search", { query, limit: 10 });
      result.innerHTML = `<pre class="codebox">${esc(objectText(response.result?.data || response.result))}</pre>`;
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
