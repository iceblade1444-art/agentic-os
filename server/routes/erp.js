import { Router } from "express";
import { config } from "../config.js";
import { db } from "../store.js";
import * as mcp from "../mcp/manager.js";
import { authenticatedUser, requireRoles } from "../lib/auth.js";
import { knowledge } from "../lib/knowledge.js";

const r = Router();
const ERP_ID = "mcp_erp";
const READ_TOOLS = [
  ["erp_me", {}],
  ["erp_gm_summary", {}],
  ["erp_active_production", {}],
  ["erp_business_control", { limit: 25 }],
  ["erp_late_orders", { limit: 12 }],
  ["erp_inventory_status", {}],
  ["erp_finished_goods_stock", { limit: 50 }],
  ["erp_finance_summary", {}],
  ["erp_list_employee_tasks", { limit: 20 }],
];
// Every signed-in role may read the ERP. Tools with a side effect in the ERP
// itself (erp_create_task, erp_send_notification) stay with operators.
const READ_ONLY_TOOLS = new Set([...READ_TOOLS.map(([tool]) => tool), "erp_search"]);
const requireOperator = requireRoles("Creator", "Admin");
const isOperator = (req) => ["Creator", "Admin"].includes(authenticatedUser(req)?.role);

function parseMcp(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text || "";
  try { return JSON.parse(text); } catch { return { ok: true, text }; }
}

async function ensureConnected() {
  const server = db.mcp.get(ERP_ID);
  if (!server) throw new Error("Milana ERP MCP server is not registered");
  if (!mcp.isLive(ERP_ID)) {
    const { tools } = await mcp.connect(server);
    db.mcp.update(ERP_ID, { status: "active", tools });
  }
  return db.mcp.get(ERP_ID);
}

async function call(tool, args = {}) {
  await ensureConnected();
  return parseMcp(await mcp.callTool(ERP_ID, tool, args));
}

async function safeCall(tool, args) {
  try { return await call(tool, args); } catch (error) { return { ok: false, status: "agentic_os_error", message: error.message }; }
}

function fmt(value) {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "number") return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  return String(value);
}

function compactJson(value) {
  return JSON.stringify(value || {}, null, 2);
}

function table(headers, rows) {
  if (!rows?.length) return "_No live rows right now._";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows,
  ].join("\n");
}

function buildWikiNotes({ me, summary, production, control, inventory, finishedGoods, finance }) {
  const now = new Date().toISOString();
  const busiest = control?.answer_hints?.busiest_sewing_flow || {};
  const nextWarehouse = control?.answer_hints?.next_warehouse_order || {};
  const flows = control?.busiest_sewing_flows || [];
  const warehouse = control?.warehouse_eta || [];
  const stages = control?.stage_summary || [];
  const cutting = control?.cutting_department || {};
  const cuttingItems = cutting?.items || [];
  const items = inventory?.items || [];
  const readyGoodsModels = finishedGoods?.top_models || [];
  const activeWork = Number(production?.active_work_orders || 0);
  const output = Number(production?.cutting_output || 0)
    + Number(production?.printing_output || 0)
    + Number(production?.sewing_output || 0)
    + Number(production?.packaging_output || 0);

  const index = `# Milana ERP Wiki

Updated: ${now}

Milana ERP is the live business source for production, inventory, finance, planning and operational questions. MILA and Hermes should use ERP MCP tools for live facts, then use this wiki for interpretation.

## Current authenticated integration

- ERP user: ${fmt(me?.name)} (${fmt(me?.email)})
- Role: ${fmt(me?.role)}
- Department: ${fmt(me?.department)}
- Permissions: ${(me?.permissions || []).join(", ") || "-"}

## Main live questions MILA should answer

- Which sewing flow is most loaded right now?
- Which order reaches warehouse next?
- Which production orders are blocked or late?
- What is the current production output by stage?
- Which inventory items need attention?
- What finished goods are ready in warehouse?
- What should Hermes put on Kanban next?

## Live headline

- Active tracked orders: ${fmt(control?.total_orders)}
- Cutting department: ${fmt(cutting?.orders)} orders, ${fmt(cutting?.planned_quantity)} planned qty, ${fmt(cutting?.overdue_orders)} overdue
- Active work orders: ${fmt(activeWork)}
- Total staged production output: ${fmt(output)}
- Finished goods stock: ${fmt(finishedGoods?.total_pieces)} pcs, ${fmt(finishedGoods?.total_packages)} packages, ${fmt(finishedGoods?.total_models)} models
- Busiest sewing flow: ${fmt(busiest?.flow)} (${fmt(busiest?.orders)} orders, ${fmt(busiest?.planned_quantity)} planned qty)
- Next warehouse order: ${fmt(nextWarehouse?.production_no || nextWarehouse?.order_no)} due ${fmt(nextWarehouse?.warehouse_eta)}

Related notes: [[ERP/Production Control]], [[ERP/Sewing Flows]], [[ERP/Warehouse ETA]], [[ERP/Finished Goods]], [[ERP/Inventory]], [[ERP/MILA ERP Playbook]]
`;

  const productionNote = `# ERP Production Control

Updated: ${now}

## Dashboard production

- Cutting output: ${fmt(production?.cutting_output)}
- Printing output: ${fmt(production?.printing_output)}
- Sewing output: ${fmt(production?.sewing_output)}
- Packaging output: ${fmt(production?.packaging_output)}
- Rework quantity: ${fmt(production?.rework_qty)}
- Active work orders: ${fmt(production?.active_work_orders)}

## Stage load

${table(["Stage", "Orders", "Planned qty", "Actual qty"], stages.slice(0, 20).map((row) =>
  `| ${fmt(row.stage)} | ${fmt(row.orders)} | ${fmt(row.planned_quantity)} | ${fmt(row.actual_quantity)} |`
))}

## Cutting department

Use this section for questions about the cutting room / раскройный отдел.

- Current cutting orders: ${fmt(cutting?.orders)}
- Planned cutting quantity: ${fmt(cutting?.planned_quantity)}
- Actual cutting quantity: ${fmt(cutting?.actual_quantity)}
- Overdue cutting orders: ${fmt(cutting?.overdue_orders)}
- Blocked cutting orders: ${fmt(cutting?.blocked_orders)}

${table(["Production", "Order", "Model", "Qty", "Deadline", "Status", "Overdue"], cuttingItems.slice(0, 30).map((row) =>
  `| ${fmt(row.production_no)} | ${fmt(row.order_no)} | ${fmt(row.model_code)} | ${fmt(row.planned_quantity)} | ${fmt(row.deadline)} | ${fmt(row.status)} | ${fmt(row.overdue)} |`
))}

## Raw production snapshot

\`\`\`json
${compactJson(production)}
\`\`\`
`;

  const flowsNote = `# ERP Sewing Flows

Updated: ${now}

## How to answer

When the user asks "which sewing flow is most loaded?", answer from this table and mention both order count and planned quantity. If blocked is greater than zero, say it needs attention.

## Busiest sewing flows

${table(["Flow", "Orders", "Planned qty", "In progress", "Waiting", "Blocked"], flows.slice(0, 20).map((row) =>
  `| ${fmt(row.flow)} | ${fmt(row.orders)} | ${fmt(row.planned_quantity)} | ${fmt(row.in_progress)} | ${fmt(row.waiting)} | ${fmt(row.blocked)} |`
))}
`;

  const warehouseNote = `# ERP Warehouse ETA

Updated: ${now}

## How to answer

When the user asks "when will this order be in warehouse?", search by production number, sales order or model code. Use warehouse ETA and current stage. If the requested order is absent, say it is not in the current process-tracking window and offer to search ERP.

## Next warehouse transfers

${table(["Production", "Order", "Model", "Qty", "Warehouse ETA", "Status"], warehouse.slice(0, 30).map((row) =>
  `| ${fmt(row.production_no)} | ${fmt(row.order_no)} | ${fmt(row.model_code)} | ${fmt(row.planned_quantity)} | ${fmt(row.warehouse_eta)} | ${fmt(row.warehouse_status)} |`
))}
`;

  const inventoryNote = `# ERP Inventory

Updated: ${now}

This note is for fabric/material inventory. For ready product warehouse stock, use [[ERP/Finished Goods]] and the erp_finished_goods_stock MCP tool.

## Current inventory sample

${table(["SKU", "Item", "Category", "Available", "Reserved", "Unit"], items.slice(0, 50).map((row) =>
  `| ${fmt(row.sku)} | ${fmt(row.name)} | ${fmt(row.category)} | ${fmt(row.available_quantity ?? row.quantity)} | ${fmt(row.reserved_quantity)} | ${fmt(row.unit)} |`
))}

## Raw finance snapshot

\`\`\`json
${compactJson(finance)}
\`\`\`
`;

  const finishedGoodsNote = `# ERP Finished Goods

Updated: ${now}

Live source of truth: /warehouse-stock + /warehouse-map
API source: /api/packages/storage-map

Use this note and erp_finished_goods_stock for questions about "склад готовых изделий", "готовая продукция", "ready product", "finished goods" or "FGS".
Do not answer finished-goods questions from production output, GM summary or material inventory. Production output is what the factory produced; finished-goods stock is what is physically accepted into ready-product warehouse cells.

## Current ready product stock

- Total pieces: ${fmt(finishedGoods?.total_pieces)}
- Available pieces: ${fmt(finishedGoods?.available_pieces)}
- Reserved pieces: ${fmt(finishedGoods?.reserved_pieces)}
- Packages: ${fmt(finishedGoods?.total_packages)}
- Models: ${fmt(finishedGoods?.total_models)}
- Sections: ${(finishedGoods?.sections || []).join(", ") || "-"}

${table(["Model", "Name", "Color", "Order", "Pieces", "Packages", "Location", "Sizes", "Status"], readyGoodsModels.slice(0, 50).map((row) =>
  `| ${fmt(row.model_code)} | ${fmt(row.model_name)} | ${fmt(row.color)} | ${fmt(row.order_no)} | ${fmt(row.total_pieces)} | ${fmt(row.packages)} | ${fmt((row.sample_rows || []).map((sample) => sample.location || [sample.cell, sample.shelf].filter(Boolean).join("/")).filter(Boolean).join(", "))} | ${fmt(Object.entries(row.sizes || {}).map(([size, qty]) => `${size}: ${qty}`).join(", "))} | ${fmt(Object.entries(row.statuses || {}).map(([status, qty]) => `${status}: ${qty}`).join(", "))} |`
))}

## Raw finished-goods snapshot

\`\`\`json
${compactJson(finishedGoods)}
\`\`\`
`;

  const playbook = `# MILA ERP Playbook

Updated: ${now}

MILA is allowed to read ERP business data through MCP and summarize it for the owner. MILA must not create ERP tasks or send notifications without explicit confirmation.

## Answering style

- Answer in the user's language.
- Give the direct answer first, then the reason.
- For business-control questions, use live ERP MCP data before guessing.
- If ERP returns zero or empty values, say exactly which ERP endpoint gave no data.
- If a question requires a write action, ask for confirmation before using write tools.

## Good questions MILA should support

- "Какой швейный поток самый загруженный?"
- "Когда заказ PO-2026-000099 будет на складе?"
- "Какие заказы зависли?"
- "Что Hermes должен поставить в Kanban по ERP?"
- "Что происходит с производством сегодня?"
- "Какие материалы на складе в риске?"

## MCP tools

- erp_me: current integration user and permissions.
- erp_gm_summary: management dashboard summary.
- erp_active_production: production dashboard.
- erp_business_control: best tool for business-control questions.
- erp_inventory_status: inventory dashboard.
- erp_finished_goods_stock: ready product / finished goods warehouse stock.
- erp_finance_summary: finance dashboard if permissions allow.
- erp_search: global ERP search.
- erp_send_notification / erp_create_task: write actions, confirmation required.
`;

  return [
    ["ERP/README.md", index],
    ["ERP/Production Control.md", productionNote],
    ["ERP/Sewing Flows.md", flowsNote],
    ["ERP/Warehouse ETA.md", warehouseNote],
    ["ERP/Finished Goods.md", finishedGoodsNote],
    ["ERP/Inventory.md", inventoryNote],
    ["ERP/MILA ERP Playbook.md", playbook],
  ];
}

r.get("/", async (req, res) => {
  const configured = !!config.erp.bearerToken || (!!config.erp.username && !!config.erp.password);
  const server = db.mcp.get(ERP_ID);
  const snapshot = {
    ok: true,
    configured,
    baseUrl: config.erp.baseUrl,
    server: {
      id: ERP_ID,
      name: server?.name || "milana-erp",
      status: mcp.isLive(ERP_ID) ? "active" : (server?.status || "stopped"),
      tools: mcp.isLive(ERP_ID) ? mcp.getTools(ERP_ID) : (server?.tools || []),
    },
    cards: {},
    errors: {},
    updatedAt: Date.now(),
  };

  if (!configured) {
    snapshot.errors.configuration = "ERP_MCP_BEARER_TOKEN or ERP_MCP_USERNAME/ERP_MCP_PASSWORD is not set on the Agentic OS server.";
    return res.json(snapshot);
  }

  const entries = await Promise.all(READ_TOOLS.map(async ([tool, args]) => [tool, await safeCall(tool, args)]));
  for (const [tool, result] of entries) {
    if (result?.ok === false) snapshot.errors[tool] = result.message || result.status || "ERP tool failed";
    snapshot.cards[tool] = result?.data ?? result;
  }
  snapshot.server.status = mcp.isLive(ERP_ID) ? "active" : snapshot.server.status;
  snapshot.server.tools = mcp.isLive(ERP_ID) ? mcp.getTools(ERP_ID) : snapshot.server.tools;
  res.json(snapshot);
});

r.post("/tool", async (req, res) => {
  const { tool, args } = req.body || {};
  if (!tool || !String(tool).startsWith("erp_")) return res.status(400).json({ error: "ERP tool name is required" });
  if (!READ_ONLY_TOOLS.has(String(tool)) && !isOperator(req)) {
    return res.status(403).json({ error: "forbidden", code: "erp_read_only", requiredRoles: ["Creator", "Admin"] });
  }
  const result = await call(tool, args || {});
  res.json({ ok: true, result });
});

r.post("/wiki-sync", requireOperator, async (req, res) => {
  const cards = {};
  const errors = {};
  for (const [tool, args] of READ_TOOLS) {
    const result = await safeCall(tool, args);
    if (result?.ok === false) errors[tool] = result.message || result.status || "ERP tool failed";
    cards[tool] = result?.data ?? result;
  }
  const notes = buildWikiNotes({
    me: cards.erp_me,
    summary: cards.erp_gm_summary,
    production: cards.erp_active_production,
    control: cards.erp_business_control,
    inventory: cards.erp_inventory_status,
    finishedGoods: cards.erp_finished_goods_stock,
    finance: cards.erp_finance_summary,
  });
  const written = [];
  for (const [notePath, content] of notes) {
    const note = await knowledge.upsert(notePath, content, { actor: req.user?.name || "Creator", source: "erp-wiki-sync" });
    written.push({ path: note.path, title: note.title, size: note.size });
  }
  res.json({ ok: true, notes: written, errors, updatedAt: Date.now() });
});

export default r;
