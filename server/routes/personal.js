import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { memberWorkspaces } from "../lib/member-workspace.js";
import { onboarding, userSoulDocument } from "../lib/onboarding.js";
import { personalBriefing } from "../lib/personal.js";
import { pendingApprovals } from "../lib/pulse.js";

const r = Router();

const settle = (promise, fallback, timeoutMs = 2800) => Promise.race([
  Promise.resolve(promise).catch(() => fallback),
  new Promise((resolve) => setTimeout(resolve, timeoutMs, fallback).unref?.()),
]);

r.get("/", async (req, res, next) => {
  try {
    const user = req.user || authenticatedUser(req);
    const state = onboarding.get(user);
    const dashboard = memberWorkspaces.dashboard(user.id);
    const operator = ["Creator", "Admin"].includes(user.role);
    const approvalResult = operator ? await settle(pendingApprovals(), null) : [];
    const approvals = Array.isArray(approvalResult) ? approvalResult : [];
    const soul = userSoulDocument(user, state);

    res.json({
      account: user,
      profile: state.profile,
      workspace: {
        name: state.workspace?.name || "Agentic OS",
        canEdit: state.canEditWorkspace,
      },
      counts: dashboard.counts,
      tasks: dashboard.tasks,
      notes: dashboard.notes,
      approvals,
      approvalsAvailable: operator ? approvalResult !== null : false,
      briefing: personalBriefing(user, dashboard, state, approvals),
      soul: {
        path: soul.path,
        content: soul.content,
        updatedAt: state.profile?.updatedAt || null,
      },
      sources: {
        tasks: "connected",
        notes: "connected",
        soul: state.profile?.completedAt ? "connected" : "setup_required",
        mila: "connected",
        calendar: "not_connected",
        inbox: "not_connected",
      },
    });
  } catch (error) { next(error); }
});

export default r;

