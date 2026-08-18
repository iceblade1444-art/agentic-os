// Integrations REST API — connect/disconnect, test, and (Slack) send a message.
import { Router } from "express";
import { db } from "../store.js";
import { PROVIDERS, testConnection, slackSend } from "../lib/connectors.js";
import { milaConnectionCode, milaDevices, milaGeminiChat, milaLiveKitToken, milaRevokeDevice, milaSetAppUpdate, milaSetSubscription, milaStatus, milaVoiceToken } from "../lib/mila.js";
import { authenticatedUser, mobilePairingGrant, requireRoles } from "../lib/auth.js";

const r = Router();
const requireAdmin = requireRoles("Creator", "Admin", "CEO");

const mask = (cfg = {}) => Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, v ? "••••••" + String(v).slice(-4) : ""]));
const view = (i) => {
  const p = PROVIDERS[i.provider] || {};
  return {
    id: i.id, provider: i.provider, name: p.name || i.provider, desc: p.desc || "",
    icon: p.icon || "integrations", color: p.color || "violet", fields: p.fields || [],
    connected: i.connected, testedAt: i.testedAt, lastResult: i.lastResult, config: mask(i.config),
  };
};

r.get("/", requireAdmin, (req, res) => res.json(db.integrations.list().map(view)));

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
  try { res.json(await handler(milaConfig(), req.body || {}, req)); }
  catch (e) { res.status(e.status >= 400 && e.status < 600 ? e.status : 502).json({ error: e.message }); }
};

// Bound what the browser can push into the upstream chat: recent turns only,
// four images per turn, and text clamped well under the backend's own limit.
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;
function chatMessages(value) {
  return (Array.isArray(value) ? value : []).slice(-24).map((message) => ({
    role: message?.role === "assistant" ? "assistant" : "user",
    content: String(message?.content || "").trim().slice(0, 30000),
    // Filter before capping, so unsupported files cannot crowd out real images.
    attachments: (Array.isArray(message?.attachments) ? message.attachments : [])
      .filter((item) => typeof item?.data === "string" && item.data.length <= MAX_IMAGE_CHARS
        && /^image\/(jpeg|png|webp)$/.test(String(item?.mimeType || "")))
      .slice(0, 4)
      .map((item) => ({ mimeType: item.mimeType, data: item.data })),
  })).filter((message) => message.content || message.attachments.length);
}

// Status, token minting and chat are open to every signed-in role — this is the
// voice/text conversation any Member can have with Mila from the web dashboard.
r.get("/mila/status", milaAction((cfg) => milaStatus(cfg)));
r.get("/mila/devices", requireAdmin, milaAction((cfg) => milaDevices(cfg)));
r.delete("/mila/devices/:id", requireAdmin, milaAction((cfg, _body, req) => milaRevokeDevice(cfg, req.params.id)));
r.post("/mila/voice-token", milaAction((cfg, body) => milaVoiceToken(cfg, "Agentic OS dashboard", { language: body.language || "auto" })));
r.post("/mila/livekit-token", milaAction((cfg, body) => milaLiveKitToken(cfg, "Agentic OS dashboard", { language: body.language || "auto", profile: body.profile })));
r.post("/mila/chat", milaAction((cfg, body) => milaGeminiChat(cfg, "Agentic OS dashboard", {
  messages: chatMessages(body?.messages),
  systemPrompt: String(body?.systemPrompt || "").slice(0, 30000),
  model: /^[a-zA-Z0-9._-]{1,100}$/.test(String(body?.model || "")) ? String(body.model) : "",
})));
r.post("/mila/connection-code", requireAdmin, milaAction((cfg, body, req) => {
  const user = authenticatedUser(req);
  return milaConnectionCode(cfg, body.label || user.email || user.name, {
    accountGrant: mobilePairingGrant(user),
    owner: {
      id: user.id,
      email: user.email || "",
      name: user.name || "",
      role: user.role || "User",
    },
  });
}));
r.post("/mila/subscription", requireAdmin, milaAction((cfg, body) => milaSetSubscription(cfg, body)));
r.post("/mila/app-update", requireAdmin, milaAction((cfg, body) => milaSetAppUpdate(cfg, body)));

export default r;
