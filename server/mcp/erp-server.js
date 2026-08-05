// Milana ERP MCP bridge. Exposes safe business-read tools and confirmed write
// tools to Agentic OS, Hermes, Claude and MILA through the local MCP host.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const config = {
  baseUrl: (process.env.ERP_API_BASE_URL || "https://erp.milanapremium.uz").replace(/\/$/, ""),
  token: process.env.ERP_MCP_BEARER_TOKEN || "",
  username: process.env.ERP_MCP_USERNAME || "",
  password: process.env.ERP_MCP_PASSWORD || "",
  authMode: process.env.ERP_MCP_AUTH_MODE || "bearer",
  requireConfirmation: process.env.ERP_MCP_REQUIRE_CONFIRMATION !== "false",
  maxBulkRecipients: Math.max(1, Number(process.env.ERP_MCP_MAX_BULK_RECIPIENTS) || 25),
};

let sessionToken = "";

const jsonText = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

function notConfigured(tool) {
  return jsonText({
    ok: false,
    status: "not_configured",
    tool,
    message: "Set ERP_MCP_BEARER_TOKEN or ERP_MCP_USERNAME/ERP_MCP_PASSWORD in Agentic OS .env to enable Milana ERP access.",
    baseUrl: config.baseUrl,
  });
}

function normalizeArgs(args = {}) {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

async function callErpTool(tool, args = {}, preferredMethod = "POST") {
  const auth = await erpAuthHeader();
  if (!auth) return notConfigured(tool);
  const payload = normalizeArgs(args);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: auth,
  };

  const endpoint = `${config.baseUrl}/api/mcp/${encodeURIComponent(tool)}`;
  let response = await fetch(endpoint, {
    method: preferredMethod,
    headers,
    body: preferredMethod === "GET" ? undefined : JSON.stringify(payload),
  });

  if (response.status === 404 || response.status === 405) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value !== "object") query.set(key, String(value));
    }
    response = await fetch(`${endpoint}${query.size ? `?${query}` : ""}`, { method: "GET", headers });
  }

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
  if (!response.ok) {
    return jsonText({
      ok: false,
      status: "erp_error",
      tool,
      httpStatus: response.status,
      message: data.error || data.message || text.slice(0, 600) || "ERP request failed",
    });
  }
  return jsonText({ ok: true, tool, data });
}

async function fetchErpPath(pathname, args = {}) {
  const auth = await erpAuthHeader();
  if (!auth) return notConfigured(pathname);
  const payload = normalizeArgs(args);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== "object") query.set(key, String(value));
  }
  const response = await fetch(`${config.baseUrl}${pathname}${query.size ? `?${query}` : ""}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: auth,
    },
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
  if (!response.ok) return jsonText({ ok: false, status: "erp_error", tool: pathname, httpStatus: response.status, message: data.error || data.message || text.slice(0, 600) || "ERP request failed" });
  return jsonText({ ok: true, data, source: pathname });
}

async function erpAuthHeader() {
  if (config.token) return `${config.authMode === "bearer" ? "Bearer" : config.authMode} ${config.token}`;
  if (!config.username || !config.password) return "";
  if (!sessionToken) sessionToken = await loginErp();
  return `Bearer ${sessionToken}`;
}

async function loginErp() {
  const body = new URLSearchParams();
  body.set("username", config.username);
  body.set("password", config.password);
  const response = await fetch(`${config.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const setCookie = response.headers.get("set-cookie") || "";
  const match = setCookie.match(/(?:^|;\s*)erp_access_token=([^;]+)/) || setCookie.match(/erp_access_token=([^;]+)/);
  let token = match?.[1] ? decodeURIComponent(match[1]) : "";
  if (!token) {
    const text = await response.text();
    try {
      const data = text ? JSON.parse(text) : {};
      token = data.access_token || "";
    } catch {
      token = "";
    }
  }
  if (!response.ok || !token) throw new Error("ERP login failed");
  return token;
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function findStage(item, operation) {
  return (Array.isArray(item?.stages) ? item.stages : []).find((stage) => stage?.operation === operation);
}

function orderBrief(item) {
  return {
    production_order_id: item.production_order_id,
    production_no: item.production_no,
    order_no: item.order_no || item.sales_order_no,
    model_code: item.model_code,
    model_name: item.model_name,
    planned_quantity: item.planned_quantity,
    actual_quantity: item.actual_quantity,
    deadline: item.po_deadline,
  };
}

function sewingFlowName(item) {
  if (item?.current_sewing_flow && typeof item.current_sewing_flow === "object") {
    return item.current_sewing_flow.name || item.current_sewing_flow.code || null;
  }
  if (item?.current_sewing_flow) return String(item.current_sewing_flow);
  const sewing = findStage(item, "sewing");
  if (sewing?.sewing_flow_name || sewing?.sewing_flow_code) return sewing.sewing_flow_name || sewing.sewing_flow_code;
  const factories = Array.isArray(item?.sewing_factories) ? item.sewing_factories : [];
  return factories[0]?.name || factories[0]?.code || null;
}

function businessControlSnapshot(rows, limit = 25) {
  const stageCounts = new Map();
  const flows = new Map();
  const blocked = [];
  const overdue = [];
  const warehouse = [];
  const cuttingOrders = [];

  for (const item of Array.isArray(rows) ? rows : []) {
    if (!item || typeof item !== "object") continue;
    const stage = String(item.current_stage || "unknown");
    const stageBucket = stageCounts.get(stage) || { stage, orders: 0, planned_quantity: 0, actual_quantity: 0 };
    stageBucket.orders += 1;
    stageBucket.planned_quantity += numberValue(item.planned_quantity);
    stageBucket.actual_quantity += numberValue(item.actual_quantity);
    stageCounts.set(stage, stageBucket);

    const flow = sewingFlowName(item);
    if (flow) {
      const flowBucket = flows.get(flow) || { flow, orders: 0, planned_quantity: 0, in_progress: 0, waiting: 0, blocked: 0 };
      flowBucket.orders += 1;
      flowBucket.planned_quantity += numberValue(item.planned_quantity);
      const status = String(item.current_stage_status || "").toLowerCase();
      if (["in_progress", "in progress", "active", "running"].includes(status)) flowBucket.in_progress += 1;
      else flowBucket.waiting += 1;
      if (item.is_blocked) flowBucket.blocked += 1;
      flows.set(flow, flowBucket);
    }

    const brief = orderBrief(item);
    if (item.is_blocked) blocked.push({ ...brief, stage, blocked_by: item.blocked_by });
    if (item.po_overdue || (Array.isArray(item.stages) && item.stages.some((stageItem) => stageItem?.overdue))) {
      overdue.push({ ...brief, stage, deadline: item.po_deadline });
    }
    if (stage === "cutting") {
      const cutting = findStage(item, "cutting");
      cuttingOrders.push({
        ...brief,
        status: item.current_stage_status,
        deadline: item.po_deadline || cutting?.deadline,
        overdue: Boolean(item.po_overdue || cutting?.overdue),
        blocked: Boolean(item.is_blocked),
      });
    }

    const storage = findStage(item, "storage_transfer");
    if (storage) {
      warehouse.push({
        ...brief,
        warehouse_eta: storage.deadline,
        warehouse_status: storage.status,
        warehouse_overdue: Boolean(storage.overdue),
      });
    }
  }

  const stageSummary = [...stageCounts.values()].sort((a, b) => b.planned_quantity - a.planned_quantity);
  const cuttingStage = stageSummary.find((item) => item.stage === "cutting") || null;
  const busiest = [...flows.values()].sort((a, b) => (b.planned_quantity - a.planned_quantity) || (b.orders - a.orders));
  const warehouseEta = warehouse.sort((a, b) => String(a.warehouse_eta || "").localeCompare(String(b.warehouse_eta || ""))).slice(0, limit);
  const cuttingItems = cuttingOrders
    .sort((a, b) => Number(Boolean(b.overdue)) - Number(Boolean(a.overdue)) || String(a.deadline || "").localeCompare(String(b.deadline || "")))
    .slice(0, limit);
  return {
    total_orders: Array.isArray(rows) ? rows.length : 0,
    stage_summary: stageSummary,
    cutting_department: {
      source: "/api/process-tracking",
      stage: "cutting",
      orders: cuttingStage?.orders || 0,
      planned_quantity: cuttingStage?.planned_quantity || 0,
      actual_quantity: cuttingStage?.actual_quantity || 0,
      overdue_orders: cuttingItems.filter((item) => item.overdue).length,
      blocked_orders: cuttingItems.filter((item) => item.blocked).length,
      items: cuttingItems,
    },
    busiest_sewing_flows: busiest.slice(0, limit),
    blocked_orders: blocked.slice(0, limit),
    overdue_orders: overdue.slice(0, limit),
    warehouse_eta: warehouseEta,
    answer_hints: {
      cutting_department: {
        orders: cuttingStage?.orders || 0,
        planned_quantity: cuttingStage?.planned_quantity || 0,
        actual_quantity: cuttingStage?.actual_quantity || 0,
        overdue_orders: cuttingItems.filter((item) => item.overdue).length,
        top_orders: cuttingItems.slice(0, 5),
      },
      busiest_sewing_flow: busiest[0] || null,
      next_warehouse_order: warehouseEta[0] || null,
    },
  };
}

function finishedGoodsMatches(item, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  return [
    item?.model_code,
    item?.model_name,
    item?.order_no,
    item?.sales_order_no,
    item?.color,
    item?.status,
    item?.section,
    item?.cell,
    item?.shelf,
  ].some((value) => String(value || "").toLowerCase().includes(needle));
}

function finishedGoodsRow(item) {
  return {
    model_code: item?.model_code,
    model_name: item?.model_name,
    order_no: item?.order_no || item?.sales_order_no,
    color: item?.color,
    size: item?.size || item?.size_label,
    quantity: item?.quantity ?? item?.total_quantity,
    available_qty: item?.available_qty ?? item?.available_quantity,
    reserved_qty: item?.reserved_qty ?? item?.reserved_quantity,
    package_id: item?.package_id || item?.package_no || item?.package_code,
    section: item?.section,
    cell: item?.cell,
    shelf: item?.shelf,
    location: item?.location || (item?.cell && item?.shelf ? `${item.cell}/${item.shelf}` : null),
    status: item?.status,
  };
}

function storageMapFinishedGoodsRows(data) {
  const placements = Array.isArray(data?.placements) ? data.placements : [];
  return placements.filter((item) => item && typeof item === "object").map((item) => {
    const cell = item.storage_cell || item.cell || "";
    const shelf = item.storage_shelf || item.shelf || "";
    const zone = cell ? String(cell).split("-")[0] : item.zone;
    return {
      ...item,
      quantity: item.total_quantity ?? item.quantity,
      available_quantity: item.available_quantity ?? item.total_quantity ?? item.quantity,
      reserved_quantity: item.reserved_quantity ?? item.reserved_qty ?? 0,
      package_id: item.package_no || item.package_id,
      section: zone,
      cell,
      shelf,
      location: item.location || (cell && shelf ? `${cell}/${shelf}` : cell || null),
    };
  });
}

function cleanNumber(value) {
  const number = numberValue(value);
  return Number.isInteger(number) ? number : Number(number.toFixed(3));
}

function finishedGoodsSnapshot(rows, limit = 50, query = "") {
  const filtered = (Array.isArray(rows) ? rows : []).filter((item) => item && typeof item === "object" && finishedGoodsMatches(item, query));
  const models = new Map();
  const packages = new Set();
  const sections = new Set();
  const statuses = new Map();
  let totalPieces = 0;
  let availablePieces = 0;
  let reservedPieces = 0;

  for (const item of filtered) {
    const quantity = numberValue(item.quantity ?? item.total_quantity);
    const available = numberValue(item.available_qty ?? item.available_quantity ?? quantity);
    const reserved = numberValue(item.reserved_qty ?? item.reserved_quantity);
    totalPieces += quantity;
    availablePieces += available;
    reservedPieces += reserved;

    const packageId = item.package_id || item.package_no || item.package_code;
    if (packageId !== undefined && packageId !== null) packages.add(String(packageId));
    if (item.section) sections.add(String(item.section));
    const status = String(item.status || "unknown");
    statuses.set(status, (statuses.get(status) || 0) + quantity);

    const modelCode = String(item.model_code || "").trim();
    const modelName = String(item.model_name || "").trim();
    const color = String(item.color || "").trim();
    const orderNo = String(item.order_no || item.sales_order_no || "").trim();
    const key = [modelCode, modelName, color, orderNo].join("\u0000");
    const bucket = models.get(key) || {
      model_code: modelCode,
      model_name: modelName,
      color,
      order_no: orderNo,
      total_pieces: 0,
      available_pieces: 0,
      reserved_pieces: 0,
      packages: new Set(),
      sections: new Set(),
      sizes: new Map(),
      statuses: new Map(),
      sample_rows: [],
    };
    bucket.total_pieces += quantity;
    bucket.available_pieces += available;
    bucket.reserved_pieces += reserved;
    if (packageId !== undefined && packageId !== null) bucket.packages.add(String(packageId));
    if (item.section) bucket.sections.add(String(item.section));
    bucket.statuses.set(status, (bucket.statuses.get(status) || 0) + quantity);
    const size = String(item.size || item.size_label || "").trim() || "unknown";
    bucket.sizes.set(size, (bucket.sizes.get(size) || 0) + quantity);
    if (bucket.sample_rows.length < 5) bucket.sample_rows.push(finishedGoodsRow(item));
    models.set(key, bucket);
  }

  const topModels = [...models.values()].map((bucket) => ({
    model_code: bucket.model_code,
    model_name: bucket.model_name,
    color: bucket.color,
    order_no: bucket.order_no,
    total_pieces: cleanNumber(bucket.total_pieces),
    available_pieces: cleanNumber(bucket.available_pieces),
    reserved_pieces: cleanNumber(bucket.reserved_pieces),
    packages: bucket.packages.size,
    sections: [...bucket.sections].sort(),
    sizes: Object.fromEntries([...bucket.sizes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([size, value]) => [size, cleanNumber(value)])),
    statuses: Object.fromEntries([...bucket.statuses.entries()].map(([name, value]) => [name, cleanNumber(value)])),
    sample_rows: bucket.sample_rows,
  })).sort((a, b) => b.total_pieces - a.total_pieces).slice(0, limit);

  return {
    source: "/api/packages/storage-map",
    source_page: "/warehouse-stock",
    map_page: "/warehouse-map",
    meaning: "Finished goods / ready product warehouse stock from the ERP warehouse-stock page and warehouse-map placements. Do not confuse with fabric/material inventory or production output.",
    query: query || null,
    total_rows: filtered.length,
    total_models: models.size,
    total_packages: packages.size,
    total_pieces: cleanNumber(totalPieces),
    available_pieces: cleanNumber(availablePieces),
    reserved_pieces: cleanNumber(reservedPieces),
    sections: [...sections].sort(),
    statuses: Object.fromEntries([...statuses.entries()].map(([name, value]) => [name, cleanNumber(value)])),
    top_models: topModels,
    answer_hints: {
      ready_goods_total_pieces: cleanNumber(totalPieces),
      ready_goods_packages: packages.size,
      top_ready_goods_model: topModels[0] || null,
      ready_goods_source_of_truth: "/warehouse-stock + /warehouse-map",
      do_not_use_for_ready_goods: ["production_output", "cutting_output", "sewing_output", "packaging_output", "material_inventory"],
    },
  };
}

async function businessControlTool(args = {}) {
  const response = await fetchErpPath("/api/process-tracking", args);
  const parsed = JSON.parse(response.content[0].text);
  if (!parsed.ok || !Array.isArray(parsed.data)) return response;
  return jsonText({
    ok: true,
    data: businessControlSnapshot(parsed.data, Math.min(100, Math.max(1, Number(args?.limit) || 25))),
    source: "/api/process-tracking",
  });
}

async function finishedGoodsTool(args = {}) {
  let response = await fetchErpPath("/api/packages/storage-map", {});
  const parsed = JSON.parse(response.content[0].text);
  let rows = parsed.ok ? storageMapFinishedGoodsRows(parsed.data) : [];
  if (!rows.length) {
    response = await fetchErpPath("/api/finished-goods", {});
    const fallback = JSON.parse(response.content[0].text);
    if (!fallback.ok || !Array.isArray(fallback.data)) return response;
    rows = fallback.data;
  }
  return jsonText({
    ok: true,
    data: finishedGoodsSnapshot(rows, Math.min(200, Math.max(1, Number(args?.limit) || 50)), args?.query || ""),
    source: "/api/packages/storage-map",
    source_page: "/warehouse-stock",
    map_page: "/warehouse-map",
  });
}

function requireConfirmation(tool, args) {
  if (!config.requireConfirmation || args?.confirmed === true) return null;
  return jsonText({
    ok: false,
    status: "confirmation_required",
    tool,
    message: `Repeat ${tool} with confirmed=true after the user explicitly approves this ERP write action.`,
  });
}

const server = new McpServer({ name: "milana-erp", version: "1.0.0" });

server.registerTool("erp_me", {
  description: "Current authenticated ERP user and permissions.",
  inputSchema: {},
}, async () => callErpTool("erp_me", {}, "GET"));

server.registerTool("erp_gm_summary", {
  description: "GM management dashboard summary: business health, sales, production and key alerts.",
  inputSchema: { from: z.string().optional(), to: z.string().optional() },
}, async (args) => callErpTool("erp_gm_summary", args));

server.registerTool("erp_search", {
  description: "Global ERP search with sensitive fields redacted.",
  inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional() },
}, async (args) => callErpTool("erp_search", args));

server.registerTool("erp_active_production", {
  description: "Active production dashboard status: current orders, stages, blockers and workload.",
  inputSchema: {},
}, async () => callErpTool("erp_active_production", {}, "GET"));

server.registerTool("erp_business_control", {
  description: "Business-control snapshot from process tracking: busiest sewing flows, stage workload, blocked/late orders and warehouse ETA.",
  inputSchema: { limit: z.number().int().min(1).max(100).optional() },
}, async (args) => businessControlTool(args));

server.registerTool("erp_late_orders", {
  description: "Late active orders derived from production dashboard data.",
  inputSchema: { limit: z.number().int().min(1).max(100).optional() },
}, async (args) => callErpTool("erp_late_orders", args));

server.registerTool("erp_inventory_status", {
  description: "Fabric/material inventory dashboard summary. Not finished-goods/ready-product stock.",
  inputSchema: {},
}, async () => callErpTool("erp_inventory_status", {}, "GET"));

server.registerTool("erp_finished_goods_stock", {
  description: "Finished-goods warehouse stock from ERP /warehouse-stock and /warehouse-map (/api/packages/storage-map): ready product pieces, packages, models, colors, cells, shelves and availability. This is the only source for ready-product warehouse questions.",
  inputSchema: {
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
}, async (args) => finishedGoodsTool(args));

server.registerTool("erp_finance_summary", {
  description: "Finance dashboard summary when ERP permissions allow it.",
  inputSchema: { from: z.string().optional(), to: z.string().optional() },
}, async (args) => callErpTool("erp_finance_summary", args));

server.registerTool("erp_list_employee_tasks", {
  description: "Task list with safe filters.",
  inputSchema: {
    employee: z.string().optional(),
    status: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
}, async (args) => callErpTool("erp_list_employee_tasks", args));

server.registerTool("erp_send_notification", {
  description: "Confirmed ERP notification send only. Requires confirmed=true.",
  inputSchema: {
    recipientIds: z.array(z.string()).min(1).max(config.maxBulkRecipients),
    message: z.string().min(1),
    confirmed: z.boolean().optional(),
  },
}, async (args) => requireConfirmation("erp_send_notification", args) || callErpTool("erp_send_notification", args));

server.registerTool("erp_create_task", {
  description: "Confirmed ERP task creation only. Requires confirmed=true.",
  inputSchema: {
    title: z.string().min(1),
    assignee: z.string().optional(),
    body: z.string().optional(),
    dueDate: z.string().optional(),
    confirmed: z.boolean().optional(),
  },
}, async (args) => requireConfirmation("erp_create_task", args) || callErpTool("erp_create_task", args));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[milana-erp] MCP server ready on stdio");
