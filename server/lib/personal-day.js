// Assembles everything the day plan needs, for whoever asks: the Personal page,
// MILA's tools and the morning routine all read the identical plan.
//
// The calendar, approvals and ERP are remote and allowed to be slow or missing.
// Each one degrades to empty instead of failing the plan, so a briefing always
// renders — with a stated gap rather than an invented number.

import { erpDigest } from "./erp-digest.js";
import { googleWorkspace } from "./google-workspace.js";
import { memberWorkspaces } from "./member-workspace.js";
import { onboarding } from "./onboarding.js";
import { buildDayPlan } from "./personal-planner.js";
import { pendingApprovals } from "./pulse.js";

const settle = (promise, fallback, timeoutMs = 4000) => Promise.race([
  Promise.resolve(promise).catch(() => fallback),
  new Promise((resolve) => setTimeout(resolve, timeoutMs, fallback).unref?.()),
]);

export async function dayPlanFor(user, options = {}) {
  const now = options.now || new Date();
  const workspaces = options.memberWorkspaces || memberWorkspaces;
  const calendar = options.googleWorkspace || googleWorkspace;
  const digest = options.erpDigest || erpDigest;
  const approvalsOf = options.pendingApprovals || pendingApprovals;
  const state = (options.onboarding || onboarding).get(user);
  const operator = ["Creator", "Admin"].includes(user.role);
  const google = calendar.status(user.id);

  const [events, approvals, erp] = await Promise.all([
    google.connected
      ? settle(calendar.calendarEvents(user.id, {
        from: new Date(now.getTime() - 12 * 60 * 60 * 1000),
        to: new Date(now.getTime() + 36 * 60 * 60 * 1000),
        limit: 50,
      }), { events: [] })
      : Promise.resolve({ events: [] }),
    operator ? settle(approvalsOf(), []) : Promise.resolve([]),
    operator ? settle(digest.read({ force: !!options.force }), { available: false }) : Promise.resolve({ available: false }),
  ]);

  const plan = buildDayPlan({
    user,
    profile: state.profile || {},
    tasks: workspaces.listTasks(user.id),
    events: events?.events || [],
    approvals: Array.isArray(approvals) ? approvals : [],
    erp,
    now,
  });

  return {
    ...plan,
    calendar: {
      connected: !!google.connected,
      canWrite: !!google.canWrite,
      scopeStale: !!google.scopeStale,
      configured: !!google.configured,
    },
    erp: { available: !!erp?.available, checkedAt: erp?.checkedAt || null },
  };
}
