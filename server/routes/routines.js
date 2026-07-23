import { Router } from "express";

import { requireRoles } from "../lib/auth.js";
import { hermesCronRequest } from "../lib/hermes-kanban.js";

const r = Router();
const requireAdmin = requireRoles("Creator", "Admin");
const bounded = (value, max = 200) => String(value || "").trim().slice(0, max);
const JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const ACTIONS = new Set(["pause", "resume", "trigger"]);

function jobId(value) {
  const id = bounded(value, 128);
  if (!JOB_ID.test(id)) throw Object.assign(new Error("Invalid routine id"), { status: 400 });
  return id;
}

function profile(value, fallback = "default") {
  const name = bounded(value || fallback, 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw Object.assign(new Error("Invalid profile"), { status: 400 });
  return name;
}

function stringList(value, max = 8) {
  return [...new Set((Array.isArray(value) ? value : String(value || "").split(","))
    .map((item) => bounded(item, 100)).filter(Boolean))].slice(0, max);
}

function query(pathname, values = {}) {
  const url = new URL(pathname, "http://cron.local");
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") url.searchParams.set(key, bounded(value, 200));
  return `${url.pathname}${url.search}`;
}

function send(handler) {
  return async (req, res) => {
    try { res.json(await handler(req)); }
    catch (error) { res.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({ error: error.message }); }
  };
}

r.get("/", send((req) => hermesCronRequest(query("/api/cron/jobs", { profile: req.query.profile || "all" }))));
r.get("/delivery-targets", send(() => hermesCronRequest("/api/cron/delivery-targets")));
r.get("/blueprints", send(() => hermesCronRequest("/api/cron/blueprints")));
r.get("/:id/runs", send((req) => hermesCronRequest(query(`/api/cron/jobs/${encodeURIComponent(jobId(req.params.id))}/runs`, {
  profile: req.query.profile, limit: Math.min(100, Math.max(1, Number(req.query.limit) || 20)),
}))));
r.post("/", requireAdmin, send((req) => {
  const schedule = bounded(req.body?.schedule, 120);
  const prompt = bounded(req.body?.prompt, 20000);
  const skills = stringList(req.body?.skills, 5);
  if (!schedule || (!prompt && !skills.length)) throw Object.assign(new Error("Schedule and a prompt or skill are required"), { status: 400 });
  return hermesCronRequest(query("/api/cron/jobs", { profile: profile(req.body?.profile) }), {
    method: "POST",
    body: {
      name: bounded(req.body?.name, 160),
      prompt,
      schedule,
      deliver: bounded(req.body?.deliver, 160) || "local",
      skills,
      enabled_toolsets: stringList(req.body?.enabledToolsets, 12),
      context_from: stringList(req.body?.contextFrom, 8),
      no_agent: false,
    },
    timeoutMs: 20000,
  });
}));
r.put("/:id", requireAdmin, send((req) => {
  const allowed = {};
  if (req.body?.name !== undefined) allowed.name = bounded(req.body.name, 160);
  if (req.body?.prompt !== undefined) allowed.prompt = bounded(req.body.prompt, 20000);
  if (req.body?.schedule !== undefined) allowed.schedule = bounded(req.body.schedule, 120);
  if (req.body?.deliver !== undefined) allowed.deliver = bounded(req.body.deliver, 160);
  if (req.body?.skills !== undefined) allowed.skills = stringList(req.body.skills, 5);
  if (req.body?.enabledToolsets !== undefined) allowed.enabled_toolsets = stringList(req.body.enabledToolsets, 12);
  if (!Object.keys(allowed).length) throw Object.assign(new Error("No routine updates provided"), { status: 400 });
  return hermesCronRequest(query(`/api/cron/jobs/${encodeURIComponent(jobId(req.params.id))}`, { profile: profile(req.body?.profile) }), {
    method: "PUT", body: { updates: allowed },
  });
}));
r.post("/:id/:action", requireAdmin, send((req) => {
  const action = bounded(req.params.action, 20);
  if (!ACTIONS.has(action)) throw Object.assign(new Error("Invalid routine action"), { status: 400 });
  return hermesCronRequest(query(`/api/cron/jobs/${encodeURIComponent(jobId(req.params.id))}/${action}`, { profile: profile(req.body?.profile) }), {
    method: "POST",
    timeoutMs: action === "trigger" ? 20000 : 12000,
  });
}));
r.delete("/:id", requireAdmin, send((req) => hermesCronRequest(query(`/api/cron/jobs/${encodeURIComponent(jobId(req.params.id))}`, {
  profile: profile(req.query.profile),
}), { method: "DELETE" })));

export default r;
