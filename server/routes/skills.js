import { Router } from "express";

import { requireRoles } from "../lib/auth.js";
import { hermesSkillsRequest } from "../lib/hermes-kanban.js";

const r = Router();
const requireAdmin = requireRoles("Creator", "Admin", "CEO");
const bounded = (value, max = 200) => String(value || "").trim().slice(0, max);

function query(pathname, values = {}) {
  const url = new URL(pathname, "http://skills.local");
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") url.searchParams.set(key, bounded(value, 300));
  return `${url.pathname}${url.search}`;
}

function send(handler) {
  return async (req, res) => {
    try { res.json(await handler(req)); }
    catch (error) { res.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({ error: error.message }); }
  };
}

r.get("/", send((req) => hermesSkillsRequest(query("/api/skills", { profile: req.query.profile }))));
r.get("/content", send((req) => {
  const name = bounded(req.query.name, 100);
  if (!name) throw Object.assign(new Error("Skill name is required"), { status: 400 });
  return hermesSkillsRequest(query("/api/skills/content", { name, profile: req.query.profile }));
}));
r.put("/toggle", requireAdmin, send((req) => {
  const name = bounded(req.body?.name, 100);
  if (!name || typeof req.body?.enabled !== "boolean") throw Object.assign(new Error("Skill name and enabled state are required"), { status: 400 });
  return hermesSkillsRequest("/api/skills/toggle", { method: "PUT", body: { name, enabled: req.body.enabled, profile: bounded(req.body?.profile, 64) || null } });
}));
r.post("/", requireAdmin, send((req) => {
  const name = bounded(req.body?.name, 100);
  const content = String(req.body?.content || "").slice(0, 500000);
  if (!name || !content) throw Object.assign(new Error("Skill name and content are required"), { status: 400 });
  return hermesSkillsRequest("/api/skills", { method: "POST", body: { name, content, category: bounded(req.body?.category, 100) || null, profile: bounded(req.body?.profile, 64) || null } });
}));
r.put("/content", requireAdmin, send((req) => {
  const name = bounded(req.body?.name, 100);
  const content = String(req.body?.content || "").slice(0, 500000);
  if (!name || !content) throw Object.assign(new Error("Skill name and content are required"), { status: 400 });
  return hermesSkillsRequest("/api/skills/content", { method: "PUT", body: { name, content, profile: bounded(req.body?.profile, 64) || null } });
}));
r.get("/hub/search", send((req) => hermesSkillsRequest(query("/api/skills/hub/search", {
  q: req.query.q, source: req.query.source || "all", limit: Math.min(50, Math.max(1, Number(req.query.limit) || 20)), profile: req.query.profile,
}), { timeoutMs: 35000 })));
r.get("/hub/preview", send((req) => {
  const identifier = bounded(req.query.identifier, 300);
  if (!identifier) throw Object.assign(new Error("Skill identifier is required"), { status: 400 });
  return hermesSkillsRequest(query("/api/skills/hub/preview", { identifier, profile: req.query.profile }), { timeoutMs: 35000 });
}));
r.post("/hub/install", requireAdmin, send((req) => {
  const identifier = bounded(req.body?.identifier, 300);
  if (!identifier) throw Object.assign(new Error("Skill identifier is required"), { status: 400 });
  return hermesSkillsRequest("/api/skills/hub/install", { method: "POST", body: { identifier, profile: bounded(req.body?.profile, 64) || null }, timeoutMs: 20000 });
}));

export default r;
