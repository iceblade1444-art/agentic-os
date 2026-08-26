// LLM proxy — OpenAI-compatible endpoint that streams from OpenAI or Anthropic
// using server-held keys (env or the saved Integrations connection). Fixes CORS.
import { Router } from "express";
import { Readable } from "node:stream";
import { config } from "../config.js";
import { hermesChatComplete, hermesChatStatus } from "../lib/hermes-chat.js";
import { db } from "../store.js";
import { authenticatedUser } from "../lib/auth.js";
import { sharedAgentContext } from "../lib/onboarding.js";

const r = Router();
const contextualMessages = (req, messages = []) => {
  const context = sharedAgentContext(authenticatedUser(req));
  return context ? [{ role: "system", content: context }, ...messages] : messages;
};

function keyFor(provider) {
  if (provider === "openai") return config.openai.key || db.integrations.byProvider("openai")?.config?.apiKey || "";
  if (provider === "anthropic") return config.anthropic.key || db.integrations.byProvider("anthropic")?.config?.apiKey || "";
  return "";
}
function pickProvider(model, explicit) {
  if (explicit) return explicit;
  if (/^claude/i.test(model || "")) {
    if (keyFor("anthropic")) return "anthropic";
    if (config.hermesChatSocket) return "hermes";
    return "anthropic";
  }
  if (keyFor("openai")) return "openai";
  if (keyFor("anthropic")) return "anthropic";
  if (config.hermesChatSocket) return "hermes";
  return /^claude/i.test(model || "") ? "anthropic" : "openai";
}

r.get("/status", async (req, res) => res.json({
  providers: {
    openai: { configured: !!keyFor("openai"), ready: !!keyFor("openai") },
    anthropic: { configured: !!keyFor("anthropic"), ready: !!keyFor("anthropic") },
    hermes: await hermesChatStatus(),
  },
  defaultModel: config.defaultModel,
}));

r.get("/models", (req, res) => {
  const data = [];
  if (keyFor("openai")) data.push("gpt-4o", "gpt-4o-mini");
  if (keyFor("anthropic")) data.push("claude-sonnet-5", "claude-haiku-4-5-20251001");
  if (config.hermesChatSocket) data.push("hermes/openai-codex");
  res.json({ object: "list", data: data.map((id) => ({ id, object: "model" })) });
});

// Non-streaming completion (used by orchestrators / the MCP bridge's run_llm tool).
// A reply is usually about as long as what it answers. Translation is the
// clearest case: ask for 1024 tokens and a long paragraph comes back severed
// mid-sentence. So size the ceiling from the input, and let a caller override.
function tokenBudget(body, msgs, system) {
  const asked = Number(body?.max_tokens);
  if (Number.isFinite(asked) && asked > 0) return Math.min(asked, 16384);
  const chars = (system || "").length +
    (msgs || []).reduce((n, m) => n + String(m?.content || "").length, 0);
  return Math.max(1024, Math.min(16384, Math.ceil(chars / 2) + 512));
}

r.post("/complete", async (req, res) => {
  const { model = config.defaultModel, messages, prompt, system, temperature = 0.7, provider } = req.body || {};
  const msgs = contextualMessages(req, messages || [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt || "" }]);
  const prov = pickProvider(model, provider);
  if (prov === "hermes") {
    try { return res.json(await hermesChatComplete(msgs)); }
    catch (error) { return res.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({ error: error.message }); }
  }
  const key = keyFor(prov);
  if (!key) return res.status(400).json({ error: `No API key configured for ${prov}.` });
  try {
    if (prov === "anthropic") {
      const sys = msgs.filter((m) => m.role === "system").map((m) => m.content).join("\n") || undefined;
      const um = msgs.filter((m) => m.role !== "system");
      const up = await fetch(config.anthropic.baseUrl + "/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: tokenBudget(req.body, um, sys), system: sys, messages: um }) });
      const j = await up.json();
      if (!up.ok) return res.status(502).json({ error: j.error?.message || "upstream error" });
      return res.json({ text: (j.content || []).map((c) => c.text).join(""), model });
    }
    const up = await fetch(config.openai.baseUrl + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify({ model, messages: msgs, temperature }) });
    const j = await up.json();
    if (!up.ok) return res.status(502).json({ error: j.error?.message || "upstream error" });
    return res.json({ text: j.choices?.[0]?.message?.content || "", model });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

r.post("/chat/completions", async (req, res) => {
  const { model = config.defaultModel, messages = [], temperature = 0.7, provider } = req.body || {};
  const contextual = contextualMessages(req, messages);
  const prov = pickProvider(model, provider);
  const key = keyFor(prov);
  if (prov !== "hermes" && !key) return res.status(400).json({ error: `No API key configured for ${prov}. Add it to .env or the Integrations page.` });

  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const done = () => { res.write("data: [DONE]\n\n"); res.end(); };

  try {
    if (prov === "hermes") {
      const result = await hermesChatComplete(contextual);
      for (const chunk of result.text.match(/[\s\S]{1,80}/g) || []) send({ choices: [{ delta: { content: chunk } }] });
      return done();
    }
    if (prov === "anthropic") {
      const system = contextual.filter((m) => m.role === "system").map((m) => m.content).join("\n") || undefined;
      const msgs = contextual.filter((m) => m.role !== "system");
      const up = await fetch(config.anthropic.baseUrl + "/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: tokenBudget(req.body, msgs, system), system, messages: msgs, stream: true }),
      });
      if (!up.ok) { send({ choices: [{ delta: { content: `[Anthropic error ${up.status}] ${await up.text()}` } }] }); return done(); }
      await forEachSSE(up, (json) => { if (json.type === "content_block_delta" && json.delta?.text) send({ choices: [{ delta: { content: json.delta.text } }] }); });
      return done();
    }
    // OpenAI (and OpenAI-compatible) — already emits the shape the client expects, pass through.
    const up = await fetch(config.openai.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ model, messages: contextual, temperature, stream: true }),
    });
    if (!up.ok) { send({ choices: [{ delta: { content: `[OpenAI error ${up.status}] ${await up.text()}` } }] }); return done(); }
    Readable.fromWeb(up.body).pipe(res);
  } catch (e) {
    try { send({ choices: [{ delta: { content: "[proxy error: " + e.message + "]" } }] }); done(); } catch { /* client gone */ }
  }
});

async function forEachSSE(upstream, onJson) {
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (d === "[DONE]") return;
      try { onJson(JSON.parse(d)); } catch { /* keep-alive / partial */ }
    }
  }
}

export default r;
