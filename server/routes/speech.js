import crypto from "node:crypto";
import { Router, raw } from "express";

const r = Router();
const SPEECH_URL = process.env.SPEECH_URL || "http://speech:4400";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const LANGS = new Set(["uz", "kk", "ky", "ru", "en"]);

function safeFilename(req) {
  let value;
  try { value = decodeURIComponent(req.get("X-File-Name") || ""); }
  catch { value = ""; }
  const base = (value.replace(/\\/g, "/").split("/").at(-1) || "");
  const name = base.replace(/[^\w.\- ]/g, "").replace(/^\.+/, "").trim().slice(0, 200);
  return name || "audio.webm";
}

r.get("/health", async (req, res) => {
  try {
    const upstream = await fetch(`${SPEECH_URL}/healthz`);
    res.status(upstream.status).json(await upstream.json());
  } catch { res.status(502).json({ error: "speech service unavailable" }); }
});

// Body: raw audio bytes (any container format ffmpeg understands).
// Optional ?language=uz|kk|ky|ru|en — omit for auto-detect.
r.post("/stt", raw({ type: () => true, limit: MAX_AUDIO_BYTES }), async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "empty audio body" });
    const language = LANGS.has(req.query.language) ? req.query.language : "";
    const boundary = `agentic-speech-${crypto.randomBytes(12).toString("hex")}`;
    const parts = [Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${safeFilename(req)}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ), req.body];
    if (language) parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}`));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const upstream = await fetch(`${SPEECH_URL}/stt`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat(parts),
    });
    res.status(upstream.status).json(await upstream.json());
  } catch (error) { res.status(502).json({ error: error.message }); }
});

// Body: { text, language?, speaker?, instruct? } → audio/wav
r.post("/tts", async (req, res) => {
  try {
    const { text, language, speaker, instruct, engine, speed } = req.body || {};
    if (!String(text || "").trim()) return res.status(400).json({ error: "text is required" });
    const form = new URLSearchParams({ text: String(text).slice(0, 4000) });
    for (const [k, v] of Object.entries({ language, speaker, instruct, engine, speed }))
      if (v) form.set(k, String(v).slice(0, 300));
    const upstream = await fetch(`${SPEECH_URL}/tts`, { method: "POST", body: form });
    if (!upstream.ok) {
      const raw = (await upstream.text()).slice(0, 500);
      let message = raw;
      try { message = JSON.parse(raw).detail || raw; } catch {}
      return res.status(upstream.status === 503 ? 503 : 502).json({ error: message });
    }
    res.set("Content-Type", "audio/wav");
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) { res.status(502).json({ error: error.message }); }
});

// Voice clone: raw audio sample in body, ?text=...&language=...&ref_text=...
r.post("/clone", raw({ type: () => true, limit: MAX_AUDIO_BYTES }), async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "empty reference audio" });
    const text = String(req.query.text || "").slice(0, 4000);
    if (!text.trim()) return res.status(400).json({ error: "text is required" });
    const boundary = `agentic-speech-${crypto.randomBytes(12).toString("hex")}`;
    const parts = [Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="ref_audio"; filename="${safeFilename(req)}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ), req.body];
    for (const k of ["text", "language", "ref_text"]) {
      const v = String(req.query[k] || "").slice(0, 4000);
      if (v) parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`));
    }
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const upstream = await fetch(`${SPEECH_URL}/clone`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat(parts),
    });
    if (!upstream.ok) {
      const rawBody = (await upstream.text()).slice(0, 500);
      let message = rawBody;
      try { message = JSON.parse(rawBody).detail || rawBody; } catch {}
      return res.status(upstream.status === 503 ? 503 : 502).json({ error: message });
    }
    res.set("Content-Type", "audio/wav");
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) { res.status(502).json({ error: error.message }); }
});

export default r;
