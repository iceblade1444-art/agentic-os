import crypto from "node:crypto";

import { config } from "../config.js";
import { db } from "../store.js";
import { claudeCode } from "./claude-code.js";
import { hermesDashboardStatus } from "./hermes-proxy.js";
import { hermesKanbanRequest, kanbanPath } from "./hermes-kanban.js";
import { knowledge } from "./knowledge.js";
import { knowledgeBase } from "./knowledge-base.js";
import { personalProfiles, PROFILE_CATEGORIES } from "./personal-profile.js";
import { journal } from "./journal.js";
import { onboarding } from "./onboarding.js";
import { googleWorkspace } from "./google-workspace.js";
import { memberWorkspaces } from "./member-workspace.js";
import { dayPlanFor } from "./personal-day.js";
import { spokenPlan } from "./personal-planner.js";
import { reminders } from "./reminders.js";
import { telegram } from "./telegram.js";
import { skillLearner } from "./skill-learner.js";
import { createErpBridge } from "./erp-bridge.js";
import * as mcpManager from "../mcp/manager.js";

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const WRITE_ACTIONS = new Set([
  "create_kanban_task", "delegate_to_hermes", "write_obsidian_note", "ask_claude_code", "call_mcp_tool",
  "create_calendar_event", "reschedule_calendar_event", "cancel_calendar_event",
  "create_erp_task", "send_erp_notification", "save_company_knowledge", "learn_skill",
]);
// Personal actions that still have to be asked about. They execute through the
// immediate path like the rest of the desk, but they destroy something rather
// than adding to it: a task created by mistake is one tap to delete, a fact
// forgotten by mistake is gone and MILA no longer knows it was ever true.
//
// Kept apart from WRITE_ACTIONS because that set also decides which executor
// runs; these belong to the read path and only borrow the gate.
const CONFIRMED_PERSONAL_ACTIONS = new Set(["forget_about_me"]);

const ERP_PRIORITIES = new Set(["low", "medium", "high", "urgent"]);
const ERP_TARGETS = new Set(["user", "department", "safe_group"]);

// The owner's own desk: tasks, notes, reminders and the day plan. These are not
// operator privileges — they touch nothing but the caller's private workspace, so
// every signed-in user may use them on their own data.
//
// Capture actions run immediately on purpose. "Добавь задачу" has to be one step
// or the assistant is slower than a notepad, and everything they create is visible
// and removable in one click. Calendar writes stay behind confirmation: an event
// can carry guests, and moving or cancelling one reaches other people.
export const PERSONAL_ACTIONS = new Set([
  "get_my_day_plan", "list_my_tasks", "create_my_task", "update_my_task",
  "list_my_calendar", "create_calendar_event", "reschedule_calendar_event", "cancel_calendar_event",
  "list_my_notes", "save_my_note", "remind_me", "list_my_reminders", "cancel_reminder",
  "remember_about_me", "read_about_me", "forget_about_me",
  "send_telegram",
]);
// Company knowledge every employee may read. It is the one part of the vault
// that is not operator material, and reading it is how MILA answers a question
// about the business instead of guessing — the prompt cannot carry these pages,
// only an index of them.
export const KNOWLEDGE_ACTIONS = new Set([
  "search_company_knowledge", "read_company_knowledge", "list_company_knowledge",
]);
// Live ERP figures every employee may read: the same numbers the ERP page
// already shows them, so voice and chat are not a side door but the same door.
//
// This list, PERSONAL_ACTIONS and KNOWLEDGE_ACTIONS are the audience gates, and
// they live here because four surfaces need the identical answer to "may this
// person call this?" — the web route, the phone, Telegram and the team
// messenger. Each used to keep its own copy, which is why tools added this week
// reached some channels and not others.
export const READ_ONLY_ERP_ACTIONS = new Set([
  "get_erp_business_context", "get_finished_goods_stock", "get_sewing_daily_report",
  // The product catalogue: which garments the factory makes, their sizes,
  // colours and fibre composition. No personal data and no money — the
  // materials list comes back without unit cost, which stays with finance.
  "get_models_overview", "find_models", "get_model_details",
]);
// Staff and order data: real names of people and customers, so it follows the
// person's role rather than the channel they happen to be using.
export const OPERATOR_ERP_ACTIONS = new Set([
  "get_attendance_today", "get_staff_summary", "get_order_stages",
]);

// The personal actions that change something. Reads are deliberately absent: a
// journal of every "what's on today" would bury the decisions it exists to keep.
const JOURNALLED_PERSONAL_ACTIONS = new Set([
  "create_my_task", "update_my_task", "save_my_note", "remind_me", "cancel_reminder",
  "remember_about_me", "forget_about_me",
]);

const STATUSES = new Set(["triage", "todo", "ready"]);
const PROFILES = new Set(["default", "scout", "scribe", "reach", "dev"]);

const bounded = (value, max) => String(value ?? "").trim().slice(0, max);
const integer = (value, min, max, fallback = min) => Math.max(min, Math.min(max, Number.parseInt(value, 10) || fallback));
const taskPath = (id, suffix = "", board = config.hermesKanbanBoard) => kanbanPath(`/tasks/${encodeURIComponent(id)}${suffix}`, board);

function boardTasks(board) {
  return (board?.columns || []).flatMap((column) => column.tasks || []);
}

function publicTask(task = {}) {
  return {
    id: task.id, title: task.title, status: task.status, assignee: task.assignee,
    priority: Number(task.priority) || 0, summary: bounded(task.latest_summary || task.summary || task.result, 600),
  };
}

function publicMcpTool(server, tool = {}) {
  return {
    serverId: server.id,
    server: server.name,
    kind: server.kind,
    status: mcpManager.isLive(server.id) ? "active" : (server.status === "error" ? "error" : "stopped"),
    name: tool.name,
    description: bounded(tool.description, 600),
    inputSchema: tool.inputSchema || null,
  };
}

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
  if (Array.isArray(value?.models)) return value.models;
  return [];
}

function finishedGoodsFacts(data = {}) {
  const hints = data.answer_hints || {};
  const rows = listValue(data).slice(0, 12).map((item = {}) => ({
    model: bounded(item.model || item.sku || item.model_no || item.code, 80),
    name: bounded(item.name || item.title || item.product || item.item_name, 120),
    order: bounded(item.order_no || item.order || item.order_number || item.production_order, 80),
    color: bounded(item.color || item.color_name, 80),
    section: bounded(item.section || item.zone, 40),
    cell: bounded(item.cell || item.bin || item.location, 60),
    shelf: bounded(item.shelf || item.rack, 60),
    packages: firstNumber(item.packages, item.package_count, item.total_packages),
    pieces: firstNumber(item.total_pieces, item.pieces, item.quantity, item.qty, item.available_quantity),
    status: bounded(item.status || item.state, 80),
  }));
  const totalPieces = firstNumber(
    data.total_pieces,
    data.ready_goods_total_pieces,
    data.pieces,
    hints.ready_goods_total_pieces,
    hints.total_pieces,
  );
  const totalPackages = firstNumber(data.total_packages, data.packages, hints.total_packages);
  const totalModels = firstNumber(data.total_models, data.models_count, hints.total_models);
  const sourcePage = data.source_page || "/warehouse-stock";
  const mapPage = data.map_page || "/warehouse-map";
  const source = data.source || "/api/packages/storage-map";
  const parts = [];
  if (totalPieces !== null) parts.push(`${totalPieces} pcs`);
  if (totalPackages !== null) parts.push(`${totalPackages} packages`);
  if (totalModels !== null) parts.push(`${totalModels} models`);
  return {
    ready_goods_total_pieces: totalPieces,
    total_packages: totalPackages,
    total_models: totalModels,
    source,
    source_page: sourcePage,
    map_page: mapPage,
    rows,
    answer_summary: totalPieces === null
      ? `Finished-goods stock is unavailable from ${sourcePage} + ${mapPage}; do not guess.`
      : `Finished-goods warehouse stock: ${parts.join(", ")}. Source: ${sourcePage} + ${mapPage}.`,
  };
}


// The raw sewing report is ~23 rows of ~30 mostly-null fields — far past what a
// text tool result may carry, and a clipped array once cost the owner three
// quarters of the day's output: the model summed the rows it could still see
// and answered "1255" against a real 5284. Aggregation happens here, where
// arithmetic is arithmetic, and the model receives totals it can only read.
export function sewingFacts(data = {}) {
  const reports = data.reports || {};
  const rows = Array.isArray(reports.rows) ? reports.rows : [];
  const capacity = new Map((Array.isArray(data.flows) ? data.flows : []).map((flow) => [flow.code, flow.capacity_per_day]));
  const lines = new Map();
  for (const row of rows) {
    const code = bounded(row.line_code, 20) || "?";
    const line = lines.get(code) || { code, name: bounded(row.line_name, 80), sewn: 0, defective: 0, models: new Set() };
    line.sewn += Number(row.sewn_qty) || 0;
    line.defective += Number(row.defective_qty) || 0;
    const model = bounded(row.model_no || row.manual_model_no, 40);
    if (model) line.models.add(model);
    lines.set(code, line);
  }
  const totalSewn = firstNumber(reports.total_sewn_qty) ?? [...lines.values()].reduce((t, line) => t + line.sewn, 0);
  const totalDefective = firstNumber(reports.total_defective_qty) ?? [...lines.values()].reduce((t, line) => t + line.defective, 0);
  return {
    report_date: bounded(data.report_date, 10),
    factory_code: bounded(data.factory_code, 10),
    total_sewn: totalSewn,
    total_defective: totalDefective,
    lines_reported: lines.size,
    lines: [...lines.values()]
      .sort((a, b) => b.sewn - a.sewn)
      .map((line) => ({
        code: line.code, name: line.name, sewn: line.sewn, defective: line.defective,
        capacity_per_day: firstNumber(capacity.get(line.code)),
        models: [...line.models].slice(0, 8),
      })),
    answer_summary: `Швейная выработка за ${bounded(data.report_date, 10)}: ${totalSewn} шт по ${lines.size} линиям, брак ${totalDefective}.`,
  };
}


// Hundreds of employee rows collapse to what a question about staff actually
// needs: headcount by department and status. Raw rows stay in code.
export function staffFacts(data = {}) {
  const employees = Array.isArray(data.employees) ? data.employees : [];
  const departmentNames = new Map((Array.isArray(data.departments) ? data.departments : [])
    .map((department) => [department.id, bounded(department.name || department.title, 80)]));
  const byDepartment = new Map();
  let active = 0;
  for (const person of employees) {
    if (person.status === "active") active += 1;
    const key = departmentNames.get(person.department_id) || bounded(person.department || "Без отдела", 80) || "Без отдела";
    const bucket = byDepartment.get(key) || { department: key, total: 0, active: 0 };
    bucket.total += 1;
    if (person.status === "active") bucket.active += 1;
    byDepartment.set(key, bucket);
  }
  return {
    total: employees.length,
    active,
    departments: [...byDepartment.values()].sort((a, b) => b.total - a.total).slice(0, 20),
    answer_summary: `В справочнике ${employees.length} сотрудников, активных ${active}, отделов ${byDepartment.size}.`,
  };
}

// The attendance overview shape belongs to the ERP; this trims it to a size a
// text tool result can carry and pulls the recognizable totals forward when
// they exist, without inventing names for fields we have not seen.
export function attendanceFacts(data = {}) {
  const overview = data.overview && typeof data.overview === "object" ? data.overview : {};
  // The live ERP nests the totals under overview.summary (Hikvision turnstile:
  // total_people / used_today / not_used_today); older or other shapes may keep
  // them at the top level, so both are searched.
  const source = overview.summary && typeof overview.summary === "object" ? { ...overview, ...overview.summary } : overview;
  const summary = {};
  for (const [ours, theirs] of [
    ["present", ["present", "present_count", "checked_in", "in_count", "used_today"]],
    ["absent", ["absent", "absent_count", "missing", "not_used_today"]],
    ["late", ["late", "late_count", "latecomers"]],
    ["total", ["total", "total_count", "expected", "headcount", "total_people"]],
    ["unmatched_events", ["unmatched_events"]],
  ]) {
    for (const key of theirs) {
      if (Number.isFinite(Number(source[key]))) { summary[ours] = Number(source[key]); break; }
    }
  }
  const raw = JSON.stringify(overview);
  // The ERP endpoint ignores the date it is given and always answers with the
  // current snapshot — asked for the 16th it still returns today, stamped with
  // today. Reporting that number under the requested date is how "1255 instead
  // of 5284" happened once already, so the two dates are kept apart and a
  // mismatch is stated rather than smoothed over.
  const asked = bounded(data.date, 10);
  const served = bounded(overview.date, 10);
  const stale = !!(asked && served && asked !== served);
  const label = served || asked;
  return {
    date: label,
    ...(asked ? { requested_date: asked } : {}),
    ...(stale ? { note: `ERP отдаёт только текущий срез турникета (${served}); за ${asked} данных нет.` } : {}),
    ...summary,
    ...(Number.isFinite(summary.present) && Number.isFinite(summary.total)
      ? { answer_summary: stale
        ? `За ${asked} ERP данные не отдаёт. На ${served}: прошли турникет ${summary.present} из ${summary.total}.`
        : `Прошли турникет за ${label}: ${summary.present} из ${summary.total}${Number.isFinite(summary.absent) ? `, не отмечены ${summary.absent}` : ""}.` }
      : {}),
    // The raw overview rides along only while it fits: cutting JSON mid-string
    // to force it in would hand the model a broken object.
    ...(raw.length <= 2500 ? { overview } : { overview_note: `full overview omitted (${raw.length} chars); the totals above are extracted from it` }),
  };
}

// Stage names the way the factory says them, so "какой заказ на каком этапе"
// gets "крой", not "cutting/waiting".
const STAGE_RU = { cutting: "крой", sewing: "швейка", packaging: "упаковка", storage_transfer: "на склад", completed: "готово" };
const STAGE_STATUS_RU = { waiting: "ожидание", in_progress: "в работе", completed: "завершён", blocked: "заблокирован" };

// ~46 orders × 3KB of raw ERP each; the model gets one line per order and
// honest totals. Optional filters keep a pointed question pointed.
export function processFacts(data = {}, args = {}) {
  const all = Array.isArray(data.orders) ? data.orders : [];
  const byStage = {};
  let overdueCount = 0;
  // An overdue order that has produced nothing is a different problem from one
  // that is late but nearly finished, and only the first needs someone today.
  let overdueNotStarted = 0;
  for (const row of all) {
    const stage = STAGE_RU[row.current_stage] || row.current_stage || "неизвестно";
    byStage[stage] = (byStage[stage] || 0) + 1;
    if (row.po_overdue) {
      overdueCount += 1;
      if (!Number(row.actual_quantity)) overdueNotStarted += 1;
    }
  }

  const stageFilter = bounded(args.stage, 20).toLowerCase();
  const query = bounded(args.query, 80).toLowerCase();
  const matches = (row) => {
    if (stageFilter && row.current_stage !== stageFilter && STAGE_RU[row.current_stage] !== stageFilter) return false;
    if (!query) return true;
    return [row.production_no, row.order_no, row.sales_order_no, row.model_code, row.model_name, row.customer_name]
      .some((field) => String(field ?? "").toLowerCase().includes(query));
  };

  const compact = (row) => ({
    order: bounded(row.production_no, 30),
    ...(row.sales_order_no ? { sales_order: bounded(row.sales_order_no, 30) } : {}),
    ...(row.customer_name ? { customer: bounded(row.customer_name, 60) } : {}),
    model: bounded([row.model_code, row.model_name].filter(Boolean).join(" "), 60),
    stage: STAGE_RU[row.current_stage] || bounded(row.current_stage, 20),
    status: STAGE_STATUS_RU[row.current_stage_status] || bounded(row.current_stage_status, 20) || undefined,
    plan: Number(row.planned_quantity) || 0,
    done: Number(row.actual_quantity) || 0,
    deadline: bounded(row.po_deadline, 10) || undefined,
    ...(row.po_overdue ? { overdue: true } : {}),
    ...(row.is_blocked ? { blocked_by: bounded(row.blocked_by, 60) || true } : {}),
  });

  const filtered = all.filter(matches);
  // Overdue orders first, then the nearest deadlines: the ones worth speaking
  // about before the clamp cuts the tail.
  filtered.sort((a, b) => (b.po_overdue === true) - (a.po_overdue === true)
    || String(a.po_deadline || "9999").localeCompare(String(b.po_deadline || "9999")));
  const LIMIT = 25;
  const orders = filtered.slice(0, LIMIT).map(compact);

  return {
    total_in_work: all.length,
    by_stage: byStage,
    overdue: overdueCount,
    ...(overdueNotStarted ? { overdue_not_started: overdueNotStarted } : {}),
    answer_summary: `Заказов в работе: ${all.length} (${Object.entries(byStage).map(([stage, count]) => `${stage} ${count}`).join(", ")})${overdueCount ? `, просрочено: ${overdueCount}${overdueNotStarted ? ` (не начаты ${overdueNotStarted})` : ""}` : ""}.`,
    ...(filtered.length !== all.length ? { filtered_count: filtered.length } : {}),
    orders,
    ...(filtered.length > LIMIT ? { orders_note: `showing ${LIMIT} of ${filtered.length}; narrow with stage or query args` } : {}),
  };
}

function erpTargetLabel(args = {}) {
  if (args.targetType === "department") return `department ${bounded(args.department, 80)}`;
  if (args.targetType === "safe_group") return `group ${bounded(args.safeGroup, 80)}`;
  return `user ${bounded(args.userId, 40)}`;
}

function actionSummary(name, args) {
  if (name === "save_company_knowledge") return `Write into company knowledge “${bounded(args.page, 80)}”: ${bounded(args.fact, 160)}`;
  if (name === "learn_skill") return `Teach the fleet skill “${bounded(args.name || "новый скилл", 80)}”${args.profile ? ` (profile ${bounded(args.profile, 40)})` : ""}`;
  if (name === "create_erp_task") return `Create ERP task “${bounded(args.title, 120)}” for ${args.assigneeUserId ? `user ${args.assigneeUserId}` : `department ${bounded(args.department, 80)}`}`;
  if (name === "send_erp_notification") return `Send ERP notification “${bounded(args.title, 120)}” to ${erpTargetLabel(args)}`;
  if (name === "create_calendar_event") return `Create calendar event “${bounded(args.title, 120)}” at ${bounded(args.start, 40)}`;
  if (name === "reschedule_calendar_event") return `Move calendar event ${bounded(args.eventId, 60)} to ${bounded(args.start, 40)}`;
  if (name === "cancel_calendar_event") return `Cancel calendar event ${bounded(args.eventId, 60)}`;
  if (name === "create_kanban_task") return `Create Kanban task “${bounded(args.title, 120)}”`;
  if (name === "delegate_to_hermes") return `Send “${bounded(args.title || args.goal, 120)}” to Hermes`;
  if (name === "write_obsidian_note") return `${args.mode === "append" ? "Append to" : "Create"} Obsidian note “${bounded(args.path, 160)}”`;
  if (name === "ask_claude_code") return `Start Claude Workspace task “${bounded(args.title || args.request, 120)}”`;
  if (name === "call_mcp_tool") return `Call MCP tool “${bounded(args.tool, 120)}” on “${bounded(args.server, 120)}”`;
  if (name === "forget_about_me") return `Forget the fact ${bounded(args.factId, 120)} from your personal profile`;
  return "Run Agentic OS action";
}

// One line per action, phrased so a person skimming the vault tomorrow and a model
// reading it as context both learn the same thing: what happened, to what.
function journalLine(name, args = {}, result = {}) {
  const of = (...values) => bounded(values.find((value) => value), 160);
  // Everything below the personal block is company work, and its titles belong
  // in a company file. Everything inside it is one person's own desk. The
  // journal lives at Agentic OS/Journal/<date>.md — one file a day for the whole
  // company, readable by anyone with the vault (Creator, Admin and Design), and
  // fed into every operator's agent prompt. So a personal line records that
  // something happened and to what kind of thing, never what it said: "Заметка:
  // Развод — документы к юристу" is not a sentence a colleague should be able to
  // read, and the person who wrote it never chose to publish it. Their own copy
  // is intact on the Personal page, which is where they left it.
  if (name === "create_my_task") return { kind: "task", title: "Добавлена личная задача" };
  if (name === "update_my_task") return { kind: "task", title: "Обновлена личная задача", detail: bounded(args.status, 40) };
  if (name === "save_my_note") return { kind: "note", title: "Сохранена личная заметка" };
  if (name === "remember_about_me") return { kind: "profile", title: "Дополнен личный профиль" };
  if (name === "forget_about_me") return { kind: "profile", title: "Удалён факт из личного профиля" };
  if (name === "remind_me") return { kind: "reminder", title: "Поставлено личное напоминание" };
  if (name === "cancel_reminder") return { kind: "reminder", title: "Напоминание отменено" };
  // The same rule, and it is the person's own calendar: a title like
  // "Собеседование в другой компании" is exactly the kind of thing that must not
  // appear in a file the whole company reads.
  if (name === "create_calendar_event") return { kind: "calendar", title: "Встреча в личном календаре", detail: bounded(args.start, 40) };
  if (name === "reschedule_calendar_event") return { kind: "calendar", title: "Встреча перенесена", detail: bounded(args.start, 40) };
  if (name === "cancel_calendar_event") return { kind: "calendar", title: "Встреча отменена" };
  if (name === "create_kanban_task") return { kind: "kanban", title: `Карточка: ${of(result.task?.title, args.title)}` };
  if (name === "delegate_to_hermes") return { kind: "hermes", title: `Hermes: ${of(args.title, args.goal)}` };
  if (name === "write_obsidian_note") return { kind: "vault", title: `Заметка в vault: ${of(args.path)}` };
  if (name === "ask_claude_code") return { kind: "claude", title: `Claude Workspace: ${of(args.title, args.request)}` };
  if (name === "create_erp_task") return { kind: "erp", title: `Задача в ERP: ${of(args.title)}`, detail: args.department ? `отдел ${args.department}` : `сотрудник ${args.assigneeUserId}` };
  if (name === "send_erp_notification") return { kind: "erp", title: `Уведомление в ERP: ${of(args.title)}`, detail: erpTargetLabel(args) };
  if (name === "call_mcp_tool") return { kind: "mcp", title: `MCP ${of(args.server)} · ${of(args.tool)}` };
  if (name === "learn_skill") return { kind: "skill", title: `Флот научен: ${of(args.name)}` };
  return null;
}

function cleanMutationArgs(name, args = {}) {
  if (name === "learn_skill") return {
    instruction: bounded(args.instruction, 20000), name: bounded(args.name, 60),
    profile: PROFILES.has(args.profile) ? args.profile : "",
  };
  if (name === "save_company_knowledge") return {
    page: bounded(args.page, 80), section: bounded(args.section, 120), fact: bounded(args.fact, 1500),
  };
  if (name === "create_erp_task") return {
    title: bounded(args.title, 240), description: bounded(args.description, 4000),
    assigneeUserId: Number.parseInt(args.assigneeUserId, 10) || null,
    department: bounded(args.department, 120),
    priority: ERP_PRIORITIES.has(args.priority) ? args.priority : "medium",
    dueDate: bounded(args.dueDate, 10),
  };
  if (name === "send_erp_notification") return {
    targetType: ERP_TARGETS.has(args.targetType) ? args.targetType : "user",
    userId: Number.parseInt(args.userId, 10) || null,
    department: bounded(args.department, 120),
    safeGroup: bounded(args.safeGroup, 120),
    title: bounded(args.title, 240), message: bounded(args.message, 4000),
    link: bounded(args.link, 400),
  };
  if (name === "create_calendar_event") return {
    title: bounded(args.title, 300), description: bounded(args.description, 4000),
    location: bounded(args.location, 300), start: bounded(args.start, 40), end: bounded(args.end, 40),
    timeZone: bounded(args.timeZone, 80), allDay: !!args.allDay,
  };
  if (name === "reschedule_calendar_event") return {
    eventId: bounded(args.eventId, 200), start: bounded(args.start, 40), end: bounded(args.end, 40),
    title: bounded(args.title, 300), timeZone: bounded(args.timeZone, 80),
  };
  if (name === "cancel_calendar_event") return { eventId: bounded(args.eventId, 200) };
  if (name === "create_kanban_task") return {
    title: bounded(args.title, 240), body: bounded(args.body, 20000),
    initialStatus: STATUSES.has(args.initialStatus) ? args.initialStatus : "triage",
    assignee: PROFILES.has(args.assignee) ? args.assignee : "default",
    priority: integer(args.priority, 0, 3, 0),
  };
  if (name === "delegate_to_hermes") return {
    title: bounded(args.title || args.goal, 240), goal: bounded(args.goal, 20000),
    priority: integer(args.priority, 0, 3, 1),
  };
  if (name === "write_obsidian_note") return {
    mode: args.mode === "append" ? "append" : "create",
    path: bounded(args.path, 300), content: bounded(args.content, 100000),
  };
  if (name === "ask_claude_code") return {
    title: bounded(args.title || args.request, 120), request: bounded(args.request, 30000),
    sessionId: bounded(args.sessionId, 160), mode: args.mode === "edit" ? "edit" : "plan",
  };
  if (name === "call_mcp_tool") return {
    server: bounded(args.server || args.serverId, 160),
    tool: bounded(args.tool || args.name, 160),
    args: args.args && typeof args.args === "object" && !Array.isArray(args.args) ? args.args : {},
  };
  if (name === "forget_about_me") return { factId: bounded(args.factId, 120) };
  return {};
}

function requireFields(name, args) {
  if (name === "forget_about_me" && !args.factId) {
    throw Object.assign(new Error("Which fact should be forgotten?"), { status: 400 });
  }
  if (name === "learn_skill") {
    if (!args.instruction) throw Object.assign(new Error("Describe the process the fleet should learn"), { status: 400 });
  }
  if (name === "save_company_knowledge") {
    if (!args.page) throw Object.assign(new Error("Name the knowledge page"), { status: 400 });
    if (!args.fact) throw Object.assign(new Error("There is no fact to write"), { status: 400 });
  }
  if (name === "create_erp_task") {
    if (!args.title) throw Object.assign(new Error("ERP task title is required"), { status: 400 });
    if (!args.assigneeUserId && !args.department) {
      throw Object.assign(new Error("An ERP task needs an assignee user id or a department"), { status: 400 });
    }
  }
  if (name === "send_erp_notification") {
    if (!args.title) throw Object.assign(new Error("Notification title is required"), { status: 400 });
    const target = args.targetType === "department" ? args.department
      : args.targetType === "safe_group" ? args.safeGroup : args.userId;
    if (!target) throw Object.assign(new Error("Name who receives this ERP notification"), { status: 400 });
  }
  if (name === "create_calendar_event" && (!args.title || !args.start)) throw Object.assign(new Error("Event title and start time are required"), { status: 400 });
  if (name === "reschedule_calendar_event" && (!args.eventId || !args.start)) throw Object.assign(new Error("Event id and new start time are required"), { status: 400 });
  if (name === "cancel_calendar_event" && !args.eventId) throw Object.assign(new Error("Event id is required"), { status: 400 });
  if (name === "create_kanban_task" && !args.title) throw Object.assign(new Error("Task title is required"), { status: 400 });
  if (name === "delegate_to_hermes" && !args.goal) throw Object.assign(new Error("Hermes task goal is required"), { status: 400 });
  if (name === "write_obsidian_note" && (!args.path || !args.content)) throw Object.assign(new Error("Note path and content are required"), { status: 400 });
  if (name === "ask_claude_code" && !args.request) throw Object.assign(new Error("Claude request is required"), { status: 400 });
  if (name === "call_mcp_tool" && (!args.server || !args.tool)) throw Object.assign(new Error("MCP server and tool are required"), { status: 400 });
}

export function createMilaActions(options = {}) {
  const kanbanRequest = options.kanbanRequest || hermesKanbanRequest;
  const boardName = options.board || config.hermesKanbanBoard;
  const library = options.knowledge || knowledge;
  const base = options.knowledgeBase || knowledgeBase;
  const claude = options.claude || claudeCode;
  const hermesStatus = options.hermesStatus || hermesDashboardStatus;
  const mcp = options.mcpManager || mcpManager;
  const store = options.db || db;
  const workspaces = options.memberWorkspaces || memberWorkspaces;
  const calendar = options.googleWorkspace || googleWorkspace;
  const reminderStore = options.reminders || reminders;
  const telegramBridge = options.telegram || telegram;
  const learner = options.skillLearner || skillLearner;
  const profiles = options.personalProfiles || personalProfiles;
  const dayPlan = options.dayPlanFor || dayPlanFor;
  const now = options.now || Date.now;
  const journalStore = options.journal || journal;
  const onboardingStore = options.onboarding || onboarding;
  const makeToken = options.makeToken || (() => crypto.randomBytes(24).toString("base64url"));
  const pending = new Map();

  // Writes one line into the day journal so the next session knows what this one
  // did. Best-effort on purpose: an action the user asked for must not report a
  // failure because the vault was unwritable.
  async function record(action, args, result, scope) {
    try {
      const line = journalLine(action, args, result);
      if (!line) return;
      const profile = scope.user ? (onboardingStore.get(scope.user).profile || {}) : {};
      await journalStore.append({
        actor: scope.actor,
        timezone: profile.timezone,
        kind: line.kind,
        title: line.title,
        detail: line.detail,
      });
    } catch (error) {
      console.error(`[mila] could not journal ${action}: ${error.message}`);
    }
  }

  // One way into the ERP MCP server, shared with the day planner and the
  // weekly review: the bridge owns the connect step and the retry over a pipe
  // that died under a deploy. This used to be a private copy of the same
  // dance, which meant it silently missed that retry.
  // Built from the same injected db and MCP manager as everything else here,
  // so a test that stubs those stubs the ERP too.
  const bridge = options.erpBridge || createErpBridge({ db: store, mcpManager: mcp });
  const erpCall = (tool, args = {}) => bridge.call(tool, args);

  function requireUser(context) {
    const user = context?.user;
    if (!user?.id) throw Object.assign(new Error("This action needs a signed-in user"), { status: 401 });
    return user;
  }

  function cleanupConfirmations() {
    const time = now();
    for (const [token, value] of pending) if (value.expiresAt <= time) pending.delete(token);
  }

  function stage(name, args, actor) {
    cleanupConfirmations();
    const token = makeToken();
    const summary = actionSummary(name, args);
    pending.set(token, {
      name, args, actor, summary, expiresAt: now() + CONFIRMATION_TTL_MS, stagedAt: now(),
    });
    return { confirmationRequired: true, confirmationToken: token, summary, expiresInSeconds: CONFIRMATION_TTL_MS / 1000 };
  }

  function consume(name, token, actor) {
    cleanupConfirmations();
    const value = pending.get(token);
    // Checked before it is removed. Deleting first meant anyone presenting
    // somebody else's token destroyed their staged action on the way to being
    // refused — the refusal was correct and the damage was already done.
    if (!value || value.name !== name || value.actor !== actor || value.expiresAt <= now()) {
      throw Object.assign(new Error("Confirmation expired or does not match this action"), { status: 409 });
    }
    // Single use, and only once it has been earned.
    pending.delete(token);
    return value.args;
  }

  async function createTask(args, orchestrate = false) {
    const initialStatus = orchestrate ? "triage" : args.initialStatus;
    const assignee = initialStatus === "triage" ? "default" : args.assignee;
    const created = await kanbanRequest(kanbanPath("/tasks", boardName), {
      method: "POST",
      body: {
        title: args.title, body: orchestrate ? args.goal : (args.body || null), assignee,
        priority: args.priority, triage: initialStatus === "triage", workspace_kind: "scratch", max_runtime_seconds: 3600,
      },
    });
    const id = created.task?.id;
    if (id && initialStatus === "ready") {
      await kanbanRequest(taskPath(id, "", boardName), { method: "PATCH", body: { status: "ready" } });
      await kanbanRequest(kanbanPath("/dispatch?max=4", boardName), { method: "POST", body: {} }).catch(() => {});
    }
    let orchestration = null;
    if (id && orchestrate) {
      orchestration = await kanbanRequest(taskPath(id, "/decompose", boardName), { method: "POST", body: {} })
        .then(() => "planning_started").catch((error) => `queued: ${bounded(error.message, 200)}`);
      await kanbanRequest(kanbanPath("/dispatch?max=4", boardName), { method: "POST", body: {} }).catch(() => {});
    }
    const detail = id ? await kanbanRequest(taskPath(id, "", boardName)).catch(() => created.task) : created.task || created;
    return { ok: true, action: orchestrate ? "delegate_to_hermes" : "create_kanban_task", task: publicTask(detail?.task || detail), orchestration };
  }

  async function executeWrite(name, args, context) {
    // Teaching the fleet: the draft was already shown at the staging step, so
    // confirmation installs exactly what was approved.
    if (name === "learn_skill") {
      const draft = args.draft || await learner.draft(args);
      const installed = await learner.install(draft);
      return {
        ok: installed?.success !== false,
        action: name,
        skill: { name: draft.name, description: draft.description, category: draft.category, updated: draft.update },
        note: draft.update ? "Existing skill refined with the feedback." : "New skill installed into the Hermes catalog.",
      };
    }

    // Company knowledge is what every colleague and MILA will quote afterwards,
    // so writing to it is confirmed like anything else that leaves your own desk.
    if (name === "save_company_knowledge") {
      const written = await base.addFact(args.page, { section: args.section, fact: args.fact, author: context.actor },
        { actor: context.actor, source: "mila-knowledge" });
      return { ok: true, action: name, ...written };
    }
    // ERP writes reach colleagues, so the confirmed call also carries ERP's own
    // confirm flag: without it the server would only return a preview and MILA
    // would report a task that was never actually created.
    if (name === "create_erp_task") {
      const result = await erpCall("erp_create_task", {
        title: args.title,
        description: args.description || undefined,
        assignee_user_id: args.assigneeUserId || undefined,
        department: args.department || undefined,
        priority: args.priority,
        due_date: args.dueDate || undefined,
        confirm: true,
      });
      if (result?.ok === false) throw Object.assign(new Error(bounded(result.error?.message || "ERP rejected the task", 240)), { status: 502 });
      return { ok: true, action: name, task: result?.data || result, requires_confirmation: false };
    }
    if (name === "send_erp_notification") {
      const result = await erpCall("erp_send_notification", {
        target_type: args.targetType,
        user_id: args.userId || undefined,
        department: args.department || undefined,
        safe_group: args.safeGroup || undefined,
        title: args.title,
        message: args.message || undefined,
        link: args.link || undefined,
        confirm: true,
      });
      if (result?.ok === false) throw Object.assign(new Error(bounded(result.error?.message || "ERP rejected the notification", 240)), { status: 502 });
      return { ok: true, action: name, delivery: result?.data || result, recipients: result?.recipients || null };
    }
    if (name === "create_calendar_event") {
      const user = requireUser(context);
      const { event } = await calendar.createEvent(user.id, args);
      return { ok: true, action: name, event };
    }
    if (name === "reschedule_calendar_event") {
      const user = requireUser(context);
      const { event } = await calendar.updateEvent(user.id, args.eventId, args);
      return { ok: true, action: name, event };
    }
    if (name === "cancel_calendar_event") {
      const user = requireUser(context);
      await calendar.deleteEvent(user.id, args.eventId);
      return { ok: true, action: name, eventId: args.eventId };
    }
    if (name === "create_kanban_task") return createTask(args, false);
    if (name === "delegate_to_hermes") return createTask(args, true);
    if (name === "write_obsidian_note") {
      const writeContext = { actor: context.actor, source: "mila-live" };
      const note = args.mode === "append"
        ? await library.append(args.path, args.content, writeContext)
        : await library.create(args.path, args.content, writeContext);
      return { ok: true, action: name, note: { path: note.path, title: note.title, bytes: note.size } };
    }
    if (name === "ask_claude_code") {
      const sessions = claude.listSessions();
      let session = args.sessionId ? claude.getSession(args.sessionId) : null;
      if (!session) session = sessions.find((item) => /agentic os/i.test(item.title)) || sessions[0];
      if (!session) session = claude.createSession({ title: args.title || "MILA coding task" });
      const run = claude.message(session.id, {
        text: args.request, permissionMode: args.mode === "edit" ? "acceptEdits" : "plan",
        effort: "high", maxTurns: args.mode === "edit" ? 20 : 10,
      });
      Promise.resolve(run).catch((error) => console.error(`[mila] Claude task ${session.id} failed:`, error.message));
      return { ok: true, action: name, status: "started", sessionId: session.id, title: session.title, mode: args.mode };
    }
    if (name === "call_mcp_tool") {
      const server = store.mcp.list().find((item) => item.id === args.server || item.name === args.server);
      if (!server) throw Object.assign(new Error(`MCP server not found: ${args.server}`), { status: 404 });
      if (!mcp.isLive(server.id)) {
        const connected = await mcp.connect(server);
        store.mcp.update(server.id, { status: "active", tools: connected.tools });
      }
      const result = await mcp.callTool(server.id, args.tool, args.args || {});
      return {
        ok: true,
        action: name,
        server: { id: server.id, name: server.name, kind: server.kind },
        tool: args.tool,
        result,
      };
    }
    throw Object.assign(new Error("Unsupported MILA write action"), { status: 400 });
  }

  // The owner's own desk. Capture is immediate; nothing here reaches anyone else.
  async function executePersonal(name, args, context) {
    const user = requireUser(context);

    if (name === "get_my_day_plan") {
      const plan = await dayPlan(user, { force: !!args.refresh });
      return {
        ok: true,
        plan: {
          date: plan.date, timezone: plan.timezone, summary: plan.summary,
          workday: plan.workday, agenda: plan.agenda, alerts: plan.alerts,
          next: plan.next, unplaced: plan.unplaced, stats: plan.stats,
          calendar: plan.calendar, erp: plan.erp,
        },
        spoken: spokenPlan(plan),
        source_policy: "This is the live plan. Read it out or answer from it; never invent meetings, tasks or times that are not in agenda or alerts.",
      };
    }

    if (name === "list_my_tasks") {
      const status = bounded(args.status, 20);
      const tasks = workspaces.listTasks(user.id)
        .filter((task) => (status ? task.status === status : task.status !== "done"))
        .slice(0, integer(args.limit, 1, 50, 20));
      return { count: tasks.length, tasks };
    }

    if (name === "create_my_task") {
      const task = workspaces.createTask(user.id, {
        title: bounded(args.title, 160),
        detail: bounded(args.detail, 4000),
        priority: ["low", "normal", "high"].includes(args.priority) ? args.priority : "normal",
        dueDate: bounded(args.dueDate, 10),
        status: args.status === "doing" ? "doing" : "todo",
      });
      return { ok: true, action: name, task };
    }

    if (name === "update_my_task") {
      const id = bounded(args.taskId || args.id, 160);
      if (!id) throw Object.assign(new Error("Task id is required"), { status: 400 });
      const patch = {};
      if (args.title !== undefined) patch.title = bounded(args.title, 160);
      if (args.detail !== undefined) patch.detail = bounded(args.detail, 4000);
      if (args.status !== undefined) patch.status = bounded(args.status, 20);
      if (args.priority !== undefined) patch.priority = bounded(args.priority, 20);
      if (args.dueDate !== undefined) patch.dueDate = bounded(args.dueDate, 10);
      const task = workspaces.updateTask(user.id, id, patch);
      if (!task) throw Object.assign(new Error("Task not found"), { status: 404 });
      return { ok: true, action: name, task };
    }

    if (name === "list_my_notes") {
      const query = bounded(args.query, 200).toLowerCase();
      const notes = workspaces.listNotes(user.id)
        .filter((note) => !query || `${note.title} ${note.content}`.toLowerCase().includes(query))
        .slice(0, integer(args.limit, 1, 20, 8))
        .map((note) => ({ id: note.id, title: note.title, content: bounded(note.content, 2000), updatedAt: note.updatedAt }));
      return { count: notes.length, notes };
    }

    if (name === "save_my_note") {
      const note = workspaces.createNote(user.id, {
        title: bounded(args.title, 160),
        content: bounded(args.content, 20000),
      });
      return { ok: true, action: name, note };
    }

    if (name === "remind_me") {
      const reminder = reminderStore.create(user.id, {
        title: bounded(args.title, 160),
        body: bounded(args.body, 600),
        dueAt: bounded(args.dueAt, 40),
        priority: args.priority === "high" ? "high" : "normal",
        route: bounded(args.route, 200),
      });
      return { ok: true, action: name, reminder };
    }

    if (name === "remember_about_me") {
      const fact = profiles.remember(user.id, { fact: args.fact, category: args.category });
      return { ok: true, action: name, fact, note: "Записано в личный профиль. Виден только вам." };
    }

    if (name === "read_about_me") {
      return {
        facts: profiles.list(user.id, { category: bounded(args.category, 40) }),
        categories: PROFILE_CATEGORIES,
        source_policy: "This is what the owner told you about themselves. Use it to be useful, never repeat it to anyone else, and never add to it from your own conclusions.",
      };
    }

    if (name === "forget_about_me") {
      const id = bounded(args.factId, 120);
      if (!id) throw Object.assign(new Error("Which fact should be forgotten?"), { status: 400 });
      if (!profiles.forget(user.id, id)) throw Object.assign(new Error("Fact not found"), { status: 404 });
      return { ok: true, action: name, factId: id };
    }

    if (name === "send_telegram") {
      // Delivery to the caller's own linked chat and nowhere else. The bridge
      // resolves user.id through the link that user created; there is no
      // argument that can point it at anyone else's Telegram.
      const text = bounded(args.text, 8000);
      if (!text) throw Object.assign(new Error("What should be sent?"), { status: 400 });
      const status = telegramBridge.link(user.id);
      if (!status.linked) {
        return { ok: false, linked: false, note: "Telegram is not linked. Tell them to open the Personal page and press «Привязать Telegram» — it takes one tap." };
      }
      const sent = await telegramBridge.sendText(user.id, text);
      if (!sent) throw Object.assign(new Error("Telegram delivery failed"), { status: 502 });
      return { ok: true, action: name, note: "Delivered to their own linked Telegram." };
    }

    if (name === "list_my_reminders") {
      return { reminders: reminderStore.list(user.id).slice(0, 20) };
    }

    if (name === "cancel_reminder") {
      const id = bounded(args.reminderId || args.id, 160);
      if (!id) throw Object.assign(new Error("Reminder id is required"), { status: 400 });
      const removed = reminderStore.cancel(user.id, id);
      if (!removed) throw Object.assign(new Error("Reminder not found"), { status: 404 });
      return { ok: true, action: name, reminderId: id };
    }

    if (name === "list_my_calendar") {
      const status = calendar.status(user.id);
      if (!status.connected) return { connected: false, events: [], note: "Google Calendar is not connected. Ask the owner to connect it on the Personal page." };
      const from = args.from ? new Date(args.from) : new Date();
      const to = args.to ? new Date(args.to) : new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
      const result = await calendar.calendarEvents(user.id, { from, to, limit: integer(args.limit, 1, 50, 20) });
      return { connected: true, canWrite: !!status.canWrite, ...result };
    }

    throw Object.assign(new Error("Unsupported personal action"), { status: 400 });
  }

  async function executeRead(name, args, context) {
    if (PERSONAL_ACTIONS.has(name)) return executePersonal(name, args, context);

    if (KNOWLEDGE_ACTIONS.has(name)) {
      const scope = { actor: context.actor, source: "mila-knowledge" };
      const policy = "Answer from these pages and quote them. If the page says ❔ or the answer is not there, say plainly that it is not written down yet and offer to record it — never invent a company fact.";
      if (name === "list_company_knowledge") return { pages: await base.list(scope), source_policy: policy };
      if (name === "read_company_knowledge") return { ...(await base.read(bounded(args.page, 80), scope)), source_policy: policy };
      const query = bounded(args.query, 200);
      if (!query) throw Object.assign(new Error("Search query is required"), { status: 400 });
      return { query, matches: await base.search(query, scope), source_policy: policy };
    }

    if (name === "get_attendance_today") {
      // Turnstile data is staff data: operator-only, and the route gate keeps
      // it that way because this name is in no everyone-list.
      const result = await erpCall("erp_attendance_overview", args.date ? { date: bounded(args.date, 10) } : {});
      const ok = result?.ok !== false;
      return {
        ok,
        source_policy: "Answer only from these fields. If ok is false, read error.message aloud — usually the missing ERP permission attendance.view — and never guess who came to work.",
        attendance: ok ? attendanceFacts(result?.data || {}) : (result?.data || result),
        error: result?.error,
      };
    }
    if (name === "get_staff_summary") {
      const result = await erpCall("erp_staff_directory", {});
      const ok = result?.ok !== false;
      return {
        ok,
        source_policy: "Headcount by department, from the ERP directory. If ok is false, say the directory could not be read.",
        staff: ok ? staffFacts(result?.data || {}) : (result?.data || result),
        error: result?.error,
      };
    }
    if (name === "get_order_stages") {
      // The /processes board: every production order and its stage. Customer
      // names ride along, so this stays operator-only like the staff tools.
      const result = await erpCall("erp_process_tracking", {});
      const ok = result?.ok !== false;
      return {
        ok,
        source_policy: "Answer only from these fields: stage/status per order, plan vs done, deadlines. If ok is false, say the process board could not be read — never guess where an order is.",
        processes: ok ? processFacts(result?.data || {}, args) : (result?.data || result),
        error: result?.error,
      };
    }
    if (name === "get_sewing_daily_report") {
      // The daily sewing report the owner reads at /sewing/daily-report. A 403
      // here means the MCP service account lacks sewing.daily_reports.view in
      // the ERP — the result says so, and the prompt rule turns that into an
      // honest sentence instead of "фабрика ничего не сшила".
      const result = await erpCall("erp_sewing_daily_report", {
        ...(args.reportDate ? { report_date: bounded(args.reportDate, 10) } : {}),
        factory_code: bounded(args.factoryCode, 10) || "MIL",
      });
      const ok = result?.ok !== false;
      return {
        ok,
        source_policy: "Answer only from these fields. total_sewn is the day's number; lines are per sewing line. If ok is false, read error.message aloud — usually a missing ERP permission — and never invent output numbers.",
        sewing: ok ? sewingFacts(result?.data || {}) : (result?.data || result),
        error: result?.error,
      };
    }
    if (name === "get_erp_late_orders") {
      const result = await erpCall("erp_late_orders", { limit: integer(args.limit, 1, 50, 20) });
      return {
        ok: result?.ok !== false,
        source_policy: "Answer only from these rows. If ok is false, say the ERP late-order data is missing instead of guessing.",
        late_orders: result?.data || result,
      };
    }
    if (name === "list_erp_employee_tasks") {
      const result = await erpCall("erp_list_employee_tasks", {
        employee: bounded(args.employee, 80) || undefined,
        department: bounded(args.department, 120) || undefined,
        status: bounded(args.status, 40) || undefined,
        scope: bounded(args.scope, 20) || "all",
      });
      return {
        ok: result?.ok !== false,
        source_policy: "These are real ERP tasks assigned to staff. Answer only from them and never invent an assignee or a due date.",
        tasks: result?.data || result,
        filters: result?.filters || null,
      };
    }
    // The model catalogue. Kept apart from the business-context block because
    // that one fans out to five tools to answer one broad question; these are
    // three narrow questions with one tool each.
    if (name === "get_models_overview" || name === "find_models" || name === "get_model_details") {
      const server = store.mcp.list().find((item) => item.id === "mcp_erp" || item.kind === "erp" || item.name === "milana-erp");
      if (!server) throw Object.assign(new Error("ERP MCP server is not registered"), { status: 404 });
      if (!mcp.isLive(server.id)) {
        const connected = await mcp.connect(server);
        store.mcp.update(server.id, { status: "active", tools: connected.tools });
      }
      const callTool = async (tool, toolArgs = {}) => {
        const result = await mcp.callTool(server.id, tool, toolArgs);
        const text = result?.content?.find((item) => item.type === "text")?.text || "{}";
        try { return JSON.parse(text); } catch { return { ok: true, text }; }
      };

      if (name === "get_models_overview") {
        const result = await callTool("erp_models_overview");
        return {
          ok: result?.ok !== false,
          ...(result?.data || {}),
          source_policy: "The product model catalogue. Answer only from this payload. counted_completely:false means the walk was cut short and the total is a floor, not the figure — say so. This is not warehouse stock and not production output.",
          source_page: "/models",
        };
      }

      if (name === "find_models") {
        const result = await callTool("erp_model_search", {
          query: bounded(args.query, 120),
          status: bounded(args.status, 40) || undefined,
          limit: integer(args.limit, 1, 100, 25),
        });
        const data = result?.data || {};
        return {
          ok: result?.ok !== false,
          ...data,
          source_policy: "Models matching the query. showing_all_matches:false means more matched than are listed — give the count and offer to narrow, never imply the list is complete. searched_whole_catalogue:false means even the count is a floor.",
          source_page: "/models",
        };
      }

      const result = await callTool("erp_model_details", {
        code: bounded(args.code, 80) || undefined,
        model_id: Number.parseInt(args.modelId ?? args.model_id, 10) || undefined,
      });
      if (result?.ok === false) {
        const status = Number(result.error?.status_code) || 404;
        throw Object.assign(new Error(bounded(result.error?.message, 200) || "Model not found"), { status });
      }
      return {
        ok: true,
        ...(result?.data || {}),
        source_policy: "One model, as the ERP holds it. Empty sizes, colors or composition mean the catalogue record is incomplete — say that rather than inferring from the name. materials carries quantity per piece and no cost; for cost use the finance tool.",
        source_page: "/models",
      };
    }

    if (name === "get_erp_business_context" || name === "get_finished_goods_stock") {
      const server = store.mcp.list().find((item) => item.id === "mcp_erp" || item.kind === "erp" || item.name === "milana-erp");
      if (!server) throw Object.assign(new Error("ERP MCP server is not registered"), { status: 404 });
      if (!mcp.isLive(server.id)) {
        const connected = await mcp.connect(server);
        store.mcp.update(server.id, { status: "active", tools: connected.tools });
      }
      const limit = integer(args.limit, 1, 100, 25);
      const callTool = async (tool, toolArgs = {}) => {
        const result = await mcp.callTool(server.id, tool, toolArgs);
        const text = result?.content?.find((item) => item.type === "text")?.text || "{}";
        try { return JSON.parse(text); } catch { return { ok: true, text }; }
      };
      const safeCallTool = async (tool, toolArgs = {}) => callTool(tool, toolArgs)
        .catch((error) => ({ ok: false, tool, error: { message: error.message } }));
      const finishedGoods = await safeCallTool("erp_finished_goods_stock", { limit: Math.max(limit, 50) });
      const finishedGoodsData = finishedGoods?.data || finishedGoods;
      const finishedFacts = finishedGoodsFacts(finishedGoodsData);
      if (name === "get_finished_goods_stock") {
        return {
          ok: finishedGoods?.ok !== false,
          facts: finishedFacts,
          answer_summary: finishedFacts.answer_summary,
          source_policy: "This is the only live source for finished-goods / ready-product warehouse questions. Answer only from this payload. If ok is false or total_pieces is absent, say the ERP finished-goods data is missing. Do not use production output or old memory.",
          source: finishedFacts.source,
          source_page: finishedFacts.source_page,
          map_page: finishedFacts.map_page,
          finished_goods_stock: finishedGoodsData,
          answer_hints: finishedGoodsData?.answer_hints || null,
        };
      }
      const [me, production, control, inventory, finance] = await Promise.all([
        safeCallTool("erp_me"),
        safeCallTool("erp_active_production", { limit }),
        safeCallTool("erp_business_control", { limit }),
        safeCallTool("erp_inventory_status"),
        safeCallTool("erp_finance_summary"),
      ]);
      return {
        source_policy: "Answer ERP business questions only from these live ERP tool results. If a needed field is missing, say the ERP data is missing instead of guessing. For finished-goods / ready-product warehouse questions, use finished_goods_stock only. The exact ready-stock count is finished_goods_stock.total_pieces or finished_goods_stock.answer_hints.ready_goods_total_pieces from /warehouse-stock and /warehouse-map. Never use production.production_output, cutting_output, sewing_output, packaging_output, GM summary, material inventory or old conversation memory as finished-goods warehouse stock.",
        erp_user: me?.data || me,
        production: production?.data || production,
        business_control: control?.data || control,
        cutting_department: control?.data?.cutting_department || null,
        material_inventory: inventory?.data || inventory,
        finished_goods_stock: finishedGoodsData,
        finished_goods_facts: finishedFacts,
        finance: finance?.data || finance,
        answer_hints: {
          ...(control?.data?.answer_hints || {}),
          finished_goods_stock: finishedGoodsData?.answer_hints || null,
        },
      };
    }
    if (name === "list_mcp_tools") {
      const servers = store.mcp.list();
      return {
        servers: servers.map((server) => ({
          id: server.id,
          name: server.name,
          kind: server.kind,
          desc: server.desc || "",
          status: mcp.isLive(server.id) ? "active" : (server.status === "error" ? "error" : "stopped"),
          tools: mcp.isLive(server.id) ? mcp.getTools(server.id).map((tool) => publicMcpTool(server, tool)) : [],
        })),
        tools: servers.flatMap((server) => (mcp.isLive(server.id) ? mcp.getTools(server.id) : [])
          .map((tool) => publicMcpTool(server, tool))),
      };
    }
    if (name === "get_system_status") {
      const [board, vault, claudeState, hermes] = await Promise.all([
        kanbanRequest(kanbanPath("/board", boardName)), library.status(), claude.status({ probe: false }), hermesStatus(),
      ]);
      const tasks = boardTasks(board);
      const counts = Object.fromEntries((board.columns || []).map((column) => [column.name, (column.tasks || []).length]));
      return {
        hermes: { ready: !!hermes.ready, status: hermes.status || 0 },
        kanban: { total: tasks.length, counts },
        obsidian: { ready: !!vault.ready, writable: !!vault.writable, notes: vault.notes, folders: vault.folders },
        claude: { ready: !!claudeState.ready, sessions: claude.listSessions().length, error: claudeState.error || "" },
      };
    }
    if (name === "list_kanban_tasks") {
      const board = await kanbanRequest(kanbanPath("/board", boardName));
      const status = bounded(args.status, 30);
      const assignee = bounded(args.assignee, 64);
      const query = bounded(args.query, 200).toLowerCase();
      const tasks = boardTasks(board).filter((task) => (!status || task.status === status)
        && (!assignee || task.assignee === assignee)
        && (!query || `${task.title} ${task.latest_summary || ""}`.toLowerCase().includes(query)));
      return { count: tasks.length, tasks: tasks.slice(0, 20).map(publicTask) };
    }
    if (name === "get_kanban_task") {
      const id = bounded(args.id, 160);
      if (!id) throw Object.assign(new Error("Task id is required"), { status: 400 });
      const result = await kanbanRequest(taskPath(id, "", boardName));
      return { task: publicTask(result.task || result) };
    }
    if (name === "search_obsidian_notes") {
      const query = bounded(args.query, 300);
      if (!query) throw Object.assign(new Error("Search query is required"), { status: 400 });
      const result = await library.search(query, { actor: context.actor, source: "mila-live", limit: integer(args.limit, 1, 10, 5) });
      return { query, matches: (result.matches || []).map((item) => ({ path: item.path, title: item.title, snippet: bounded(item.snippet, 500) })) };
    }
    if (name === "read_obsidian_note") {
      const path = bounded(args.path, 300);
      if (!path) throw Object.assign(new Error("Note path is required"), { status: 400 });
      const note = await library.read(path, { actor: context.actor, source: "mila-live" });
      return { path: note.path, title: note.title, content: bounded(note.content, 12000) };
    }
    if (name === "list_claude_sessions") {
      return { sessions: claude.listSessions().slice(0, 12).map((item) => ({ id: item.id, title: item.title, status: item.status, workdir: item.workdir, updatedAt: item.updatedAt })) };
    }
    throw Object.assign(new Error("Unsupported MILA action"), { status: 400 });
  }

  async function call(name, args = {}, context = {}) {
    const action = bounded(name, 80);
    const actor = bounded(context.actor || "Creator", 120);
    // A staged action belongs to the account that staged it, not just to a display
    // name, so a token minted for one user can never be spent by another.
    const identity = bounded(context.user?.id || actor, 200);
    const scope = { actor, user: context.user || null };
    // Two kinds of gated action, one gate. WRITE_ACTIONS reach other people;
    // CONFIRMED_PERSONAL_ACTIONS stay on this desk but destroy something.
    const gated = WRITE_ACTIONS.has(action) || CONFIRMED_PERSONAL_ACTIONS.has(action);
    if (gated) {
      const token = bounded(args.confirmationToken, 200);
      if (token) {
        const confirmed = consume(action, token, identity);
        const result = WRITE_ACTIONS.has(action)
          ? await executeWrite(action, confirmed, scope)
          : await executeRead(action, confirmed, scope);
        // Only after it actually happened: a staged action is not history.
        await record(action, confirmed, result, scope);
        return result;
      }
      const clean = cleanMutationArgs(action, args);
      requireFields(action, clean);
      if (action === "learn_skill") {
        // The draft is built BEFORE confirmation, so what the operator approves
        // is the skill itself, not a promise of one. The stored args carry the
        // finished draft; confirming installs exactly it.
        const draft = await learner.draft(clean);
        const staged = stage(action, { draft }, identity);
        return {
          ...staged,
          summary: `${draft.update ? "Update" : "Create"} fleet skill “${draft.name}” — ${draft.description}`,
          draft: { name: draft.name, description: draft.description, category: draft.category, body: draft.body.slice(0, 2000), update: draft.update },
        };
      }
      return stage(action, clean, identity);
    }
    if (JOURNALLED_PERSONAL_ACTIONS.has(action)) {
      const result = await executeRead(action, args, scope);
      await record(action, args, result, scope);
      return result;
    }
    return executeRead(action, args, scope);
  }

  /// Everything this person has staged and not yet answered.
  ///
  /// Without this the gate is real but invisible: MILA prepares a cancellation,
  /// the conversation ends, and five minutes later it expires with nobody ever
  /// having been asked. The token is returned because it is already the
  /// caller's own — stage() handed it to them — and it is single-use and bound
  /// to their account, so listing it widens nothing.
  function listPending(identity) {
    cleanupConfirmations();
    const id = bounded(identity, 200);
    if (!id) return [];
    return [...pending.entries()]
      .filter(([, value]) => value.actor === id)
      .sort((a, b) => a[1].stagedAt - b[1].stagedAt)
      .map(([token, value]) => ({
        token,
        action: value.name,
        summary: value.summary,
        stagedAt: new Date(value.stagedAt).toISOString(),
        expiresAt: new Date(value.expiresAt).toISOString(),
      }));
  }

  /// Answer one. Declining is a first-class outcome, not a timeout: a person
  /// who says no should see it go, not watch it linger for five minutes.
  function decline(token, identity) {
    cleanupConfirmations();
    const key = bounded(token, 200);
    const value = pending.get(key);
    if (!value || value.actor !== bounded(identity, 200)) return false;
    pending.delete(key);
    return true;
  }

  return { call, listPending, decline, pendingCount: () => pending.size };
}

export const milaActions = createMilaActions();
