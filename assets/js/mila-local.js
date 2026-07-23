// Local voice call for Mila — runs entirely on our own speech stack
// (STT + LLM router + Milana TTS), no Gemini. Hands-free loop with
// level-based auto-stop.
import { buildMilaSystemInstruction } from "./mila-session.js";

const TTS_LANG = { uz: "Uzbek", ru: "Russian", en: "English", kk: "Russian", ky: "Russian" };

let ui = null;
let stopFlag = false;
let stream = null;

function ensureUI() {
  if (ui) return ui;
  const wrap = document.createElement("div");
  wrap.id = "milaLocalOverlay";
  wrap.style.cssText = "position:fixed;right:24px;bottom:24px;width:340px;z-index:9999;background:var(--card-bg,#151527);border:1px solid rgba(128,128,255,.25);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.45);padding:14px;font-size:13px";
  wrap.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px">
      <span style="width:10px;height:10px;border-radius:50%;background:#22c55e" id="mlDot"></span>
      <b>Мила — локальный звонок</b>
      <span style="flex:1"></span>
      <button id="mlStop" style="border:0;background:#ef4444;color:#fff;border-radius:8px;padding:4px 10px;cursor:pointer">Завершить</button>
    </div>
    <div id="mlState" style="opacity:.75;margin-top:8px">инициализация…</div>
    <div id="mlLog" style="margin-top:8px;max-height:220px;overflow:auto"></div>`;
  document.body.appendChild(wrap);
  ui = {
    wrap,
    dot: wrap.querySelector("#mlDot"),
    state: wrap.querySelector("#mlState"),
    log: wrap.querySelector("#mlLog"),
  };
  wrap.querySelector("#mlStop").onclick = () => stopLocalCall();
  return ui;
}

function say(state, color) {
  if (!ui) return;
  ui.state.textContent = state;
  ui.dot.style.background = color || "#22c55e";
}

function addLine(who, text) {
  const div = document.createElement("div");
  div.style.cssText = "margin-top:6px;padding:6px 8px;border-radius:8px;background:" +
    (who === "you" ? "rgba(99,102,241,.15)" : "rgba(34,197,94,.12)");
  div.innerHTML = `<b>${who === "you" ? "Ты" : "Мила"}:</b> ${text.replace(/</g, "&lt;")}`;
  ui.log.appendChild(div);
  ui.log.scrollTop = ui.log.scrollHeight;
}

// Record until 1.4s of silence after speech began (or 15s max).
function recordUtterance() {
  return new Promise(async (resolve, reject) => {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);

    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: "audio/webm", audioBitsPerSecond: 128000 });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => { ctx.close(); resolve(new Blob(chunks, { type: "audio/webm" })); };
    rec.onerror = (e) => { ctx.close(); reject(e.error || new Error("recorder error")); };
    rec.start(250);

    let spoke = false;
    let silentMs = 0;
    let totalMs = 0;
    const tick = setInterval(() => {
      if (stopFlag) { clearInterval(tick); rec.stop(); return; }
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      const loud = peak > 12;
      totalMs += 100;
      if (loud) { spoke = true; silentMs = 0; }
      else if (spoke) silentMs += 100;
      if ((spoke && silentMs >= 1400) || totalMs >= 15000) { clearInterval(tick); rec.stop(); }
    }, 100);
  });
}

async function sttRequest(blob) {
  const res = await fetch("/api/speech/stt", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-File-Name": "call.webm" },
    body: blob,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

async function llmReply(history) {
  const system = buildMilaSystemInstruction({ language: "auto" }) +
    "\nЭто голосовой разговор: отвечай коротко (1-3 предложения), разговорно, без markdown и списков. Отвечай на языке собеседника.";
  const res = await fetch("/api/llm/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "system", content: system }, ...history], temperature: 0.7 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return (data.text || "").trim();
}

async function ttsPlay(text, lang) {
  const res = await fetch("/api/speech/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, engine: "fast", language: TTS_LANG[lang] || "Russian" }),
  });
  if (!res.ok) throw new Error((await res.json()).error || res.status);
  const url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: "audio/wav" }));
  await new Promise((done) => {
    const a = new Audio(url);
    a.onended = done;
    a.onerror = done;
    a.play().catch(done);
  });
  URL.revokeObjectURL(url);
}

export async function startLocalCall() {
  if (ui) return; // already running
  stopFlag = false;
  ensureUI();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
    } });
  } catch {
    say("нет доступа к микрофону", "#ef4444");
    return;
  }
  const history = [];
  while (!stopFlag) {
    try {
      say("слушаю… говори (пауза = конец фразы)", "#22c55e");
      const blob = await recordUtterance();
      if (stopFlag) break;
      if (blob.size < 4000) continue; // silence
      say("распознаю…", "#eab308");
      const stt = await sttRequest(blob);
      const text = (stt.text || "").trim();
      if (!text) continue;
      addLine("you", text);
      history.push({ role: "user", content: text });
      say("думаю…", "#eab308");
      const reply = await llmReply(history.slice(-8));
      if (!reply) continue;
      history.push({ role: "assistant", content: reply });
      addLine("mila", reply);
      say("говорю…", "#38bdf8");
      await ttsPlay(reply, stt.language);
    } catch (err) {
      say(`ошибка: ${err.message}`, "#ef4444");
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  ui?.wrap.remove();
  ui = null;
}

export function stopLocalCall() {
  stopFlag = true;
}
