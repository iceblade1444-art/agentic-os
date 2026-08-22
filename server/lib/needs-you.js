// The one question the console should answer before any other: what is waiting
// on a person?
//
// Everything an operator saw on opening the app was a status readout — counts,
// sparklines, service dots — none of which distinguishes "the system is busy"
// from "the system has stopped and is waiting for you". So the first act of
// every session was scanning twenty-six nav items to find out.
//
// Nothing here is new data. An agent that asked a question and stopped, an
// approval nobody has decided, a task past its date, an unread thing marked
// urgent — all four were already recorded; none of them were ever asked for
// together. That is the whole of it.
//
// Every dependency is a parameter with the real one as its default, because
// this composes four subsystems and a test that had to stand all four up would
// not get written.

const clean = (value, max = 200) => String(value ?? "").trim().slice(0, max);

// Ordered worst first. The console shows them in this order and the count badge
// takes its colour from the highest present.
export const SEVERITY = ["blocked", "waiting", "overdue", "attention"];
const rank = (severity) => {
  const at = SEVERITY.indexOf(severity);
  return at === -1 ? SEVERITY.length : at;
};

const iso = (value) => {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toISOString() : "";
};

function boardTasks(board) {
  if (!board || !Array.isArray(board.columns)) return null;
  return board.columns.flatMap((column) =>
    (column.tasks || []).map((task) => ({ ...task, status: task.status || column.name })));
}

/** An agent that asked a question and stopped. Operator-side. */
export function waitingOnAnswer(board) {
  const tasks = boardTasks(board);
  if (!tasks) return [];
  return tasks
    .filter((task) => task.status === "blocked" && task.block_kind === "needs_input")
    .slice(0, 20)
    .map((task) => ({
      id: `wait_${clean(task.id, 80)}`,
      kind: "waiting",
      severity: "waiting",
      title: clean(task.title, 160) || "Задача ждёт ответа",
      detail: clean(task.block_reason || task.assignee, 200),
      since: iso(task.blocked_at || task.updated_at || task.updatedAt),
      route: "kanban",
    }));
}

/** An agent that stopped for a reason nobody can answer by typing. */
export function blockedHard(board) {
  const tasks = boardTasks(board);
  if (!tasks) return [];
  return tasks
    .filter((task) => task.status === "blocked" && task.block_kind !== "needs_input")
    .slice(0, 20)
    .map((task) => ({
      id: `blk_${clean(task.id, 80)}`,
      kind: "blocked",
      severity: "blocked",
      title: clean(task.title, 160) || "Задача остановлена",
      detail: clean(task.block_reason || task.assignee, 200),
      since: iso(task.blocked_at || task.updated_at || task.updatedAt),
      route: "kanban",
    }));
}

/** A decision nobody has made. Operator-side. */
export function awaitingDecision(approvals) {
  if (!Array.isArray(approvals)) return [];
  return approvals.slice(0, 20).map((approval) => ({
    id: `apr_${clean(approval.id, 80)}`,
    kind: "approval",
    severity: "waiting",
    title: clean(approval.summary || approval.action, 160) || "Требуется решение",
    detail: clean(approval.project, 120),
    since: iso(approval.requestedAt),
    route: "missions",
  }));
}

/** The person's own tasks that are past their date. */
export function overdueTasks(tasks, today) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((task) => task.status !== "done" && task.dueDate && task.dueDate < today)
    .slice(0, 20)
    .map((task) => ({
      id: `due_${clean(task.id, 80)}`,
      kind: "overdue",
      severity: "overdue",
      title: clean(task.title, 160),
      detail: clean(task.detail, 200),
      since: iso(task.dueDate),
      route: "my-tasks",
    }));
}

/** Unread and marked urgent by whoever sent it. */
export function urgentUnread(inbox) {
  if (!Array.isArray(inbox)) return [];
  return inbox
    .filter((item) => item.status === "unread" && item.priority === "high")
    .slice(0, 20)
    .map((item) => ({
      id: `inb_needs_${clean(item.id, 80)}`,
      kind: "inbox",
      severity: "attention",
      title: clean(item.title, 160),
      detail: clean(item.body, 200),
      since: iso(item.createdAt),
      route: item.route || "inbox",
    }));
}

/**
 * Everything blocked on this person, worst first.
 *
 * Operator-only sources are gated here rather than in the route, so a Member
 * calling this can never be handed the fleet's blocked tasks or somebody
 * else's approval queue — the same rule the rest of the product follows: the
 * only reliable way not to say something is not to know it.
 */
export async function needsYou(user, deps = {}) {
  const isOperator = ["Creator", "Admin", "CEO"].includes(user?.role);
  const today = deps.today || new Date().toISOString().slice(0, 10);

  const own = [];
  try {
    const workspaces = deps.workspaces;
    if (workspaces) {
      own.push(...overdueTasks(workspaces.listTasks(user.id), today));
      own.push(...urgentUnread(workspaces.listInbox(user.id, { limit: 100 })));
    }
  } catch (error) {
    // One broken store must not empty the whole queue: a partial answer here is
    // still an answer, and a thrown one is a blank screen.
    console.warn(`[needs-you] personal sources failed for ${user?.id}: ${error.message}`);
  }

  if (!isOperator) return compose(own);

  const [board, approvals] = await Promise.all([
    Promise.resolve(deps.board?.()).catch(() => null),
    Promise.resolve(deps.approvals?.()).catch(() => null),
  ]);

  return compose([
    ...blockedHard(board),
    ...waitingOnAnswer(board),
    ...awaitingDecision(approvals),
    ...own,
  ]);
}

function compose(items) {
  const sorted = [...items].sort((a, b) => {
    if (a.severity !== b.severity) return rank(a.severity) - rank(b.severity);
    // Oldest first inside a severity: the thing that has been waiting longest
    // is the thing most likely to have been forgotten.
    return String(a.since).localeCompare(String(b.since));
  });
  const counts = {};
  for (const item of sorted) counts[item.kind] = (counts[item.kind] || 0) + 1;
  return {
    items: sorted.slice(0, 50),
    total: sorted.length,
    counts,
    severity: sorted.length ? sorted[0].severity : "",
  };
}
