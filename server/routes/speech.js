import crypto from "node:crypto";
import { Router, raw } from "express";
import { rateLimit } from "../lib/auth.js";
import { SPEECH_URL, speechInternalHeaders } from "../lib/speech-internal.js";

const r = Router();
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const LANGS = new Set(["uz", "kk", "ky", "ru", "en"]);

r.use(rateLimit({ windowMs: 60000, max: 60 }));

export function safeSpeechFilename(value = "") {
  try { value = decodeURIComponent(value); }
  catch { value = ""; }
  const base = (value.replace(/\\/g, "/").split("/").at(-1) || "");
  const name = base.replace(/[^\w.\- ]/g, "").replace(/^\.+/, "").trim().slice(0, 200);
  return name || "audio.webm";
}

// The secret is a parameter so this is testable without depending on whether a
// .env happens to sit next to the test run — that made the suite pass on a
// developer machine and fail on the server.
export { speechInternalHeaders };

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
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${safeSpeechFilename(req.get("X-File-Name"))}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ), req.body];
    if (language) parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}`));
    if (req.query.correct === "true") parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="correct_text"\r\n\r\ntrue`));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const upstream = await fetch(`${SPEECH_URL}/stt`, {
      method: "POST",
      headers: speechInternalHeaders({ "Content-Type": `multipart/form-data; boundary=${boundary}` }),
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
    const upstream = await fetch(`${SPEECH_URL}/tts`, {
      method: "POST",
      headers: speechInternalHeaders(),
      body: form,
    });
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
r.post(
  "/clone",
  rateLimit({ windowMs: 60 * 60000, max: 5 }),
  raw({ type: () => true, limit: MAX_AUDIO_BYTES }),
  async (req, res) => {
  try {
    if (req.query.consent !== "true") {
      return res.status(400).json({ error: "voice owner consent is required" });
    }
    if (!req.body?.length) return res.status(400).json({ error: "empty reference audio" });
    const text = String(req.query.text || "").slice(0, 4000);
    if (!text.trim()) return res.status(400).json({ error: "text is required" });
    const boundary = `agentic-speech-${crypto.randomBytes(12).toString("hex")}`;
    const parts = [Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="ref_audio"; filename="${safeSpeechFilename(req.get("X-File-Name"))}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ), req.body];
    for (const k of ["text", "language", "ref_text"]) {
      const v = String(req.query[k] || "").slice(0, 4000);
      if (v) parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`));
    }
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const upstream = await fetch(`${SPEECH_URL}/clone`, {
      method: "POST",
      headers: speechInternalHeaders({ "Content-Type": `multipart/form-data; boundary=${boundary}` }),
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
  },
);

// Body: { text, target } -> { text }
// Same router that corrects transcripts; no translation model on this box.
const LANG_NAMES = {
  uz: "узбекский", ru: "русский", en: "английский",
  kk: "казахский", ky: "киргизский",
};

// One call stays coherent to roughly 2500 characters and starts truncating
// past that, so long text is translated in sentence-sized pieces. Splitting on
// sentence ends keeps the seams inaudible when the result is read aloud.
const TRANSLATE_CHUNK = 1800;
const TRANSLATE_MAX = 20000;
const BREAKS = ["\n\n", "\n", ". ", "! ", "? ", "; "];

function splitForTranslation(text, limit = TRANSLATE_CHUNK) {
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Prefer a paragraph break, then a sentence end, then any space. A seam in
    // the middle of a sentence gives the model half a thought to translate.
    let cut = -1;
    for (const mark of BREAKS) {
      const at = window.lastIndexOf(mark);
      if (at >= 0) cut = Math.max(cut, at + mark.length - 1);
    }
    if (cut < limit * 0.5) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = limit - 1;          // no break at all: cut on length
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts.filter(Boolean);
}

async function translateOnce(text, targetName) {
  const prompt =
    "Переведи на " + targetName + " язык. Верни ТОЛЬКО перевод, " +
    "без пояснений и без кавычек.\n\n" + text;
  const secret = process.env.INTERNAL_SECRET || "";
  const upstream = await fetch(
    process.env.LLM_COMPLETE_URL || "http://agentic-os:8787/api/llm/complete",
    {
      method: "POST",
      headers: secret
        ? { "Content-Type": "application/json", "x-internal-secret": secret }
        : { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        temperature: 0,
        max_tokens: Math.ceil(text.length / 2) + 512,
      }),
    },
  );
  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 300);
    throw new Error("translation unavailable: " + detail);
  }
  const data = await upstream.json();
  const out = String(data.text || "").trim();
  if (!out) throw new Error("empty translation");
  return out;
}

r.post("/translate", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim().slice(0, TRANSLATE_MAX);
    const target = String(req.body?.target || "").toLowerCase();
    if (!text) return res.status(400).json({ error: "text is required" });
    if (!LANG_NAMES[target]) return res.status(400).json({ error: "unsupported target language" });

    const parts = splitForTranslation(text);
    const out = [];
    for (const part of parts) out.push(await translateOnce(part, LANG_NAMES[target]));
    res.json({ text: out.join("\n\n"), parts: parts.length });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

export default r;
