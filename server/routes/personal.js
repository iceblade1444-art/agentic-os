import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { memberWorkspaces } from "../lib/member-workspace.js";
import { onboarding, userSoulDocument } from "../lib/onboarding.js";
import { personalBriefing } from "../lib/personal.js";
import { pendingApprovals } from "../lib/pulse.js";
import { googleWorkspace } from "../lib/google-workspace.js";
import { personalFiles } from "../lib/personal-files.js";
import { dayPlanFor } from "../lib/personal-day.js";
import { spokenPlan } from "../lib/personal-planner.js";
import { reminders } from "../lib/reminders.js";
import { morningBrief } from "../lib/morning-brief.js";

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
    const google = googleWorkspace.status(user.id);
    const files = personalFiles.list(user.id);

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
      files,
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
        calendar: google.connected ? "connected" : google.configured ? "setup_required" : "not_connected",
        inbox: "not_connected",
        files: "connected",
      },
      google,
    });
  } catch (error) { next(error); }
});

r.get("/plan", async (req, res, next) => {
  try {
    const user = req.user || authenticatedUser(req);
    const plan = await dayPlanFor(user, { force: req.query.refresh === "1" });
    res.json(req.query.spoken === "1" ? { ...plan, spoken: spokenPlan(plan) } : plan);
  } catch (error) { next(error); }
});

// Deliver today's brief on demand: the same payload the morning tick sends, so
// what the owner tests at noon is exactly what arrives at eight.
r.post("/brief", async (req, res, next) => {
  try {
    const user = req.user || authenticatedUser(req);
    const result = await morningBrief.sendFor(user);
    res.status(201).json({ ok: true, item: result.item, date: result.plan.date });
  } catch (error) { next(error); }
});

r.get("/reminders", (req, res) => {
  const user = req.user || authenticatedUser(req);
  res.json({ reminders: reminders.list(user.id) });
});

r.post("/reminders", (req, res, next) => {
  try {
    const user = req.user || authenticatedUser(req);
    res.status(201).json({ reminder: reminders.create(user.id, req.body || {}) });
  } catch (error) { next(error); }
});

r.delete("/reminders/:id", (req, res, next) => {
  try {
    const user = req.user || authenticatedUser(req);
    if (!reminders.cancel(user.id, req.params.id)) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

r.get("/files", (req, res) => {
  const user = req.user || authenticatedUser(req);
  res.json({ files: personalFiles.list(user.id) });
});

r.post("/files", (req, res, next) => {
  try {
    const user = req.user || authenticatedUser(req);
    res.status(201).json({ file: personalFiles.add(user.id, req.body) });
  } catch (error) { next(error); }
});

r.get("/files/:id/download", (req, res, next) => {
  try {
    const user = req.user || authenticatedUser(req);
    const item = personalFiles.get(user.id, req.params.id);
    res.setHeader("Content-Type", item.type);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(item.buffer);
  } catch (error) { next(error); }
});

r.delete("/files/:id", (req, res, next) => {
  try {
    const user = req.user || authenticatedUser(req);
    res.json(personalFiles.remove(user.id, req.params.id));
  } catch (error) { next(error); }
});

r.get("/google/status", (req, res) => {
  const user = req.user || authenticatedUser(req);
  res.json(googleWorkspace.status(user.id));
});

r.post("/google/connect", (req, res, next) => {
  try {
    const user = req.user || authenticatedUser(req);
    res.json(googleWorkspace.connect(user.id, {
      client: req.body?.client,
      locale: req.body?.locale,
    }));
  } catch (error) { next(error); }
});

r.get("/google/calendar/events", async (req, res, next) => {
  try {
    const user = req.user || authenticatedUser(req);
    res.json(await googleWorkspace.calendarEvents(user.id, {
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
    }));
  } catch (error) { next(error); }
});

r.post("/google/calendar/events", async (req, res, next) => {
  try {
    const user = req.user || authenticatedUser(req);
    res.status(201).json(await googleWorkspace.createEvent(user.id, req.body || {}));
  } catch (error) { next(error); }
});

r.patch("/google/calendar/events/:id", async (req, res, next) => {
  try {
    const user = req.user || authenticatedUser(req);
    res.json(await googleWorkspace.updateEvent(user.id, req.params.id, req.body || {}));
  } catch (error) { next(error); }
});

r.delete("/google/calendar/events/:id", async (req, res, next) => {
  try {
    const user = req.user || authenticatedUser(req);
    res.json(await googleWorkspace.deleteEvent(user.id, req.params.id));
  } catch (error) { next(error); }
});

r.delete("/google", (req, res) => {
  const user = req.user || authenticatedUser(req);
  res.json(googleWorkspace.disconnect(user.id));
});

export default r;

