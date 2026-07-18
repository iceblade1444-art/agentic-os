// Integrations REST API — connect/disconnect, test, and (Slack) send a message.
import { Router } from "express";
import { db } from "../store.js";
import { PROVIDERS, testConnection, slackSend } from "../lib/connectors.js";
import { milaConnectionCode, milaSetAppUpdate, milaSetSubscription, milaStatus, milaVoiceToken } from "../lib/mila.js";
import { requireRoles } from "../lib/auth.js";

const r = Router();
const requireAdmin = requireRoles("Creator", "Admin");

const mask = (cfg = {}) => Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, v ? "••••••" + String(v).slice(-4) : ""]));
const view = (i) => {
  const p = PROVIDERS[i.provider] || {};
  return {
    id: i.id, provider: i.provider, name: p.name || i.provider, desc: p.desc || "",
    icon: p.icon || "integrations", color: p.color || "violet", fields: p.fields || [],
    connected: i.connected, testedAt: i.testedAt, lastResult: i.lastResult, config: mask(i.config),
  };
};

r.get("/", (req, res) => res.json(db.integrations.list().map(view)));

r.post("/:provider/connect", requireAdmin, async (req, res) => {
  const conn = db.integrations.byProvider(req.params.provider);
  if (!conn) return res.status(404).json({ error: "unknown provider" });
  const cfg = req.body?.config || {};
  const result = await testConnection(req.params.provider, cfg);
  db.integrations.update(conn.id, { config: cfg, connected: result.ok, testedAt: Date.now(), lastResult: result });
  res.json({ ...result, integration: view(db.integrations.get(conn.id)) });
});

r.post("/:provider/test", requireAdmin, async (req, res) => {
  const conn = db.integrations.byProvider(req.params.provider);
  if (!conn) return res.status(404).json({ error: "unknown provider" });
  const result = await testConnection(req.params.provider, conn.config);
  db.integrations.update(conn.id, { testedAt: Date.now(), lastResult: result, connected: result.ok });
  res.json(result);
});

r.post("/:provider/disconnect", requireAdmin, (req, res) => {
  const conn = db.integrations.byProvider(req.params.provider);
  if (conn) db.integrations.update(conn.id, { connected: false, config: {}, lastResult: null });
  res.json({ ok: true });
});

r.post("/slack/send", requireAdmin, async (req, res) => {
  const conn = db.integrations.byProvider("slack");
  try {
    await slackSend(conn?.config || {}, req.body?.text || "Hello from Agentic OS 👋");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const milaConfig = () => db.integrations.byProvider("mila")?.config || {};
const milaAction = (handler) => async (req, res) => {
  try { res.json(await handler(milaConfig(), req.body || {})); }
  catch (e) { res.status(502).json({ error: e.message }); }
};

r.get("/mila/status", milaAction((cfg) => milaStatus(cfg)));
r.post("/mila/voice-token", milaAction((cfg) => milaVoiceToken(cfg)));
r.post("/mila/connection-code", requireAdmin, milaAction((cfg, body) => milaConnectionCode(cfg, body.label)));
r.post("/mila/subscription", requireAdmin, milaAction((cfg, body) => milaSetSubscription(cfg, body)));
r.post("/mila/app-update", requireAdmin, milaAction((cfg, body) => milaSetAppUpdate(cfg, body)));

export default r;
