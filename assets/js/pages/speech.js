import { icon } from "../icons.js";
import { esc, toast } from "../ui.js";

const LANGS = [
  ["", "Auto"], ["uz", "O'zbekcha"], ["kk", "Qazaqsha"], ["ky", "Kyrgyzcha"], ["ru", "Русский"], ["en", "English"],
];
const TTS_LANGS = [["Russian", "Русский"], ["Uzbek", "O'zbekcha — Милана"], ["English", "English"]];
// pitch measured on our own round-trip test; all nine read Russian cleanly
const TTS_VOICES = [
  ["uncle_fu", "Дядя Фу — низкий мужской"], ["dylan", "Дилан — мужской"],
  ["ryan", "Райан — мужской"], ["aiden", "Эйден — молодой мужской"],
  ["serena", "Серена — женский"], ["sohee", "Сохи — женский"],
  ["eric", "Эрик — высокий"], ["vivian", "Вивиан — женский"],
  ["ono_anna", "Анна — высокий женский"],
];

let rec = null;
let chunks = [];
let cloneSample = null; // { blob, name }
let lastStt = null;     // { text, segments, language }

const sttHistory = JSON.parse(localStorage.getItem("speech_stt_history") || "[]");
const ttsHistory = []; // session-only (blob URLs die on refresh)

function head(title, sub) {
  return `<div class="page-head"><div><div class="page-title">${title}</div><div class="page-sub">${sub}</div></div><div class="spacer"></div><span class="badge success" id="speechLive" style="display:none"><span class="dot"></span>Сервис онлайн</span></div>`;
}

function fmtTime(s) {
  const ms = Math.round((s % 1) * 1000).toString().padStart(3, "0");
  const t = Math.floor(s);
  const hh = String(Math.floor(t / 3600)).padStart(2, "0");
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss},${ms}`;
}

function toSrt(segments) {
  return segments.map((s, i) => `${i + 1}\n${fmtTime(s.start)} --> ${fmtTime(s.end)}\n${s.text}\n`).join("\n");
}

function download(name, content, type) {
  const a = document.createElement("a");
  // a blob:/http:/data: string is already a link to the bytes — wrapping it in a
  // Blob would save the address as text instead of the audio
  const isUrl = typeof content === "string" && /^(blob:|https?:|data:)/.test(content);
  a.href = typeof content === "string" && !isUrl
    ? URL.createObjectURL(new Blob([content], { type }))
    : content;
  a.download = name;
  a.click();
}

function sttHistoryHTML() {
  if (!sttHistory.length) return `<div class="hint">история пуста</div>`;
  return sttHistory.slice(0, 8).map((h, i) => `
    <div class="row between" style="gap:8px;padding:6px 0;border-bottom:1px solid var(--border,#2223)">
      <span class="hint" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(h.text)}">${esc(h.text.slice(0, 80))}</span>
      <span class="hint">${h.lang}</span>
      <button class="icon-btn" data-stt-copy="${i}" title="Копировать">${icon("copy") || "⧉"}</button>
    </div>`).join("");
}

function ttsHistoryHTML() {
  if (!ttsHistory.length) return `<div class="hint">история пуста (живёт до обновления страницы)</div>`;
  return ttsHistory.slice(0, 8).map((h, i) => `
    <div class="row between" style="gap:8px;padding:6px 0;border-bottom:1px solid var(--border,#2223)">
      <span class="hint" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(h.text)}">${esc(h.text.slice(0, 60))}</span>
      <span class="hint">${h.mode}</span>
      <button class="icon-btn" data-tts-play="${i}" title="Слушать">▶</button>
      <button class="icon-btn" data-tts-dl="${i}" title="Скачать">⬇</button>
    </div>`).join("");
}

export default {
  title: "Speech Studio",
  render() {
    return `
    <style>
      .sp-ico { display:inline-flex; width:34px; height:34px; border-radius:10px; align-items:center; justify-content:center; background:linear-gradient(135deg,#7c3aed22,#7c3aed44); color:#7c3aed; flex:none }
      .sp-ico svg { width:18px; height:18px }
      .sp-head { display:flex; align-items:center; gap:10px; margin-bottom:4px }
      .sp-head .t { font-weight:700 }
      .sp-head .s { font-size:12px; opacity:.65 }
      .sp-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:12px }
      .sp-row label { font-size:12px; opacity:.7 }
      .sp-sec { margin-top:14px; padding-top:10px; border-top:1px solid rgba(128,128,128,.15) }
      .sp-drop { border:1.5px dashed rgba(128,128,128,.35); border-radius:10px; padding:10px; text-align:center; font-size:12px; opacity:.7; margin-top:10px; transition:background .15s }
      .sp-hist-title { font-weight:600; font-size:12px; letter-spacing:.4px; text-transform:uppercase; opacity:.55; margin-top:14px }
    </style>` +
    head("Speech Studio", "Распознавание и синтез речи на своём сервере — узбекский, казахский, киргизский, русский, английский. Без внешних API.") + `
    <div class="grid cols-2">
      <div class="card">
        <div class="sp-head"><span class="sp-ico">${icon("mic")}</span><div><div class="t">Речь → текст</div><div class="s">микрофон, файлы, субтитры</div></div></div>
        <div class="sp-row"><label>Язык</label>
          <label style="margin-left:12px"><input type="checkbox" id="sttCorrect" checked/> исправлять ошибки через ИИ</label>
          <select id="sttLang" class="input" style="width:auto">
            ${LANGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
          </select>
        </div>
        <div class="row mt-4" style="gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" id="recBtn">${icon("mic")}<span>Записать</span></button>
          <button class="btn" id="fileBtn">📁 Загрузить файл</button>
          <input type="file" id="sttFile" accept="audio/*,video/mp4" style="display:none"/>
          <span class="hint" id="recState"></span>
        </div>
        <div id="dropZone" class="sp-drop">…или перетащи аудиофайл сюда (mp3, wav, ogg, m4a — до 25 МБ)</div>
        <textarea id="sttOut" class="input mt-4" rows="5" placeholder="Здесь появится распознанный текст…"></textarea>
        <div id="minutesOut" class="mt-4" style="display:none"></div>
        <div class="row mt-4" style="gap:6px;align-items:center;flex-wrap:wrap">
          <span class="hint">Перевести на</span>
          <select id="sttTrLang" class="input" style="width:auto">
            <option value="uz">O'zbekcha</option>
            <option value="ru">Русский</option>
            <option value="en">English</option>
            <option value="kk">Қазақша</option>
            <option value="ky">Кыргызча</option>
          </select>
          <button class="btn" id="sttTranslate">Перевести</button>
          <span class="hint" id="sttTrState"></span>
        </div>
        <textarea id="sttTrOut" class="input mt-4" rows="4" placeholder="Здесь появится перевод…" style="display:none"></textarea>
        <div class="row mt-4" id="sttTrActions" style="gap:6px;display:none">
          <button class="btn btn-primary" id="sttTrSpeak">Озвучить перевод</button>
          <button class="btn" id="sttTrCopy">Копировать перевод</button>
        </div>
        <div class="row between mt-4">
          <div class="hint" id="sttMeta"></div>
          <div class="row" style="gap:6px">
            <button class="btn btn-primary" id="sttMinutes" title="MILA превратит запись в протокол: решения, поручения, сроки">Протокол совещания</button>
            <button class="btn" id="sttCopy">Копировать</button>
            <button class="btn" id="sttTxt">.txt</button>
            <button class="btn" id="sttSrt" title="Субтитры с таймкодами">.srt</button>
          </div>
        </div>
        <div class="sp-hist-title">История</div>
        <div id="sttHist">${sttHistoryHTML()}</div>
      </div>

      <div class="card">
        <div class="sp-head"><span class="sp-ico">${icon("chat")}</span><div><div class="t">Текст → речь</div><div class="s">4 режима: диалог, качество, эмоции, клон</div></div></div>
        <div class="sp-row">
          <label>Язык</label>
          <select id="ttsLang" class="input" style="width:auto">
            ${TTS_LANGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
          </select>
          <label id="ttsSpeakerLabel">Голос</label>
          <select id="ttsSpeaker" class="input" style="width:auto">
            ${TTS_VOICES.map(([v, l]) => `<option value="${v}"${v === "vivian" ? " selected" : ""}>${l}</option>`).join("")}
          </select>
          <label>Режим</label>
          <select id="ttsEngine" class="input" style="width:auto">
            <option value="fast">Быстрый — для диалога</option>
            <option value="quality">Качественный — ~30 сек</option>
            <option value="emotion">Эмоциональный — по описанию</option>
            <option value="premium">Премиум (узбекский) — наш голос</option>
            <option value="clone">Клон голоса — по образцу</option>
          </select>
        </div>
        <div class="sp-row" id="speedRow"><label>Скорость</label> <input type="range" id="ttsSpeed" min="0.7" max="1.3" step="0.05" value="1" style="width:140px"/> <span class="hint" id="speedVal">1.0x</span></div>
        <textarea id="ttsText" class="input mt-4" rows="3" placeholder="Введите текст для озвучки…" maxlength="4000">Здравствуйте! Чем я могу вам помочь?</textarea>
        <div class="hint" style="text-align:right"><span id="ttsCount">0</span>/4000</div>
        <input id="ttsInstruct" class="input mt-4" style="display:none" placeholder="Характер голоса: тёплый дружелюбный тон, с улыбкой…" value="Тёплый, дружелюбный тон, говорит с улыбкой"/>
        <div id="cloneRow" class="sp-sec" style="display:none">
          <div class="hint">Образец голоса (3–10 сек чистой записи без шума):</div>
          <div class="row mt-4" style="gap:8px">
            <button class="btn" id="cloneRecBtn">🎙 Записать образец</button>
            <button class="btn" id="cloneFileBtn">📁 Файл</button>
            <input type="file" id="cloneFile" accept="audio/*" style="display:none"/>
            <span class="hint" id="cloneState">образец не задан</span>
          </div>
          <input id="cloneRefText" class="input mt-4" placeholder="(необязательно) точный текст, произнесённый в образце — повышает похожесть"/>
          <label class="row mt-4" style="gap:8px;align-items:flex-start">
            <input type="checkbox" id="cloneConsent"/>
            <span class="hint">Подтверждаю согласие владельца голоса на создание этой озвучки</span>
          </label>
        </div>
        <div class="row mt-4" style="gap:8px">
          <button class="btn btn-primary" id="ttsBtn">${icon("sparkles")}<span>Озвучить</span></button>
          <span class="hint" id="ttsState"></span>
        </div>
        <audio id="ttsAudio" class="mt-4" controls style="width:100%;display:none"></audio>
        <a id="ttsDl" class="hint" style="display:none">⬇ Скачать аудио</a>
        <div class="sp-hist-title">История озвучек</div>
        <div id="ttsHist">${ttsHistoryHTML()}</div>
      </div>
    </div>
    <div class="hint mt-4">Клонирование голоса — только с согласия владельца голоса. Узбекский синтез — собственный голос «Милана» (обучается, скоро).</div>`;
  },

  mount(el) {
    const q = (s) => el.querySelector(s);

    fetch("/api/speech/health").then((r) => { if (r.ok) q("#speechLive").style.display = ""; }).catch(() => {});

    // ---------- STT ----------
    async function transcribeBlob(blob, name) {
      q("#recState").textContent = "распознаю…";
      try {
        const lang = q("#sttLang").value;
        const fix = q("#sttCorrect")?.checked ? "correct=true" : "";
        const qs = [lang ? `language=${lang}` : "", fix].filter(Boolean).join("&");
        const res = await fetch(`/api/speech/stt${qs ? `?${qs}` : ""}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name) },
          body: blob,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.status);
        lastStt = data;
        q("#sttOut").value = data.text || "";
        q("#sttMeta").textContent = `язык: ${data.language} · ${data.duration}s · сегментов: ${(data.segments || []).length}`;
        q("#recState").textContent = "готово";
        sttHistory.unshift({ text: data.text, lang: data.language, ts: Date.now() });
        sttHistory.length = Math.min(sttHistory.length, 20);
        localStorage.setItem("speech_stt_history", JSON.stringify(sttHistory));
        q("#sttHist").innerHTML = sttHistoryHTML();
      } catch (err) {
        q("#recState").textContent = "ошибка";
        toast(`STT: ${esc(err.message)}`);
      }
    }

    q("#sttMinutes").onclick = async () => {
      const transcript = q("#sttOut").value.trim();
      const out = q("#minutesOut");
      if (transcript.length < 40) { toast("Сначала распознайте запись — протокол строится из текста"); return; }
      q("#sttMinutes").disabled = true;
      out.style.display = "";
      out.innerHTML = `<div class="row gap-2"><div class="spinner"></div><span class="muted">MILA составляет протокол…</span></div>`;
      try {
        const res = await fetch("/api/meetings/minutes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.status);
        out.innerHTML = `<div class="card pad-lg">
          <div class="section-title">${esc(data.title)}</div>
          <p>${esc(data.summary)}</p>
          ${data.decisions.length ? `<div class="fw-600 mt-3">Решения</div><ul>${data.decisions.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}
          ${data.actions.length ? `<div class="fw-600 mt-3">Поручения</div>${data.actions.map((item, index) => `
            <div class="row between mt-2" style="gap:8px">
              <span>${esc(item.title)}${item.owner ? ` — <b>${esc(item.owner)}</b>` : ""}${item.due ? ` <span class="muted">(до ${esc(item.due)})</span>` : ""}</span>
              <button class="btn sm" data-minute-task="${index}">В мои задачи</button>
            </div>`).join("")}` : ""}
          ${data.openQuestions.length ? `<div class="fw-600 mt-3">Открытые вопросы</div><ul>${data.openQuestions.map((item) => `<li>❔ ${esc(item)}</li>`).join("")}</ul>` : ""}
          <div class="hint mt-3">${data.savedTo ? `Сохранено в vault: ${esc(data.savedTo)}` : "В vault не сохранилось — протокол только на экране"}</div>
        </div>`;
        out.querySelectorAll("[data-minute-task]").forEach((button) => {
          button.onclick = async () => {
            const item = data.actions[Number(button.dataset.minuteTask)];
            button.disabled = true;
            try {
              const created = await fetch("/api/member/tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: item.title, detail: item.owner ? `Поручение: ${item.owner}` : "Из протокола совещания", dueDate: item.due || "", status: "todo" }),
              });
              if (!created.ok) throw new Error((await created.json()).error || created.status);
              button.textContent = "Добавлено ✓";
            } catch (err) { button.disabled = false; toast(`Задача: ${esc(err.message)}`); }
          };
        });
      } catch (err) {
        out.innerHTML = `<div class="alert error"><div class="a-body"><div class="a-desc">${esc(err.message)}</div></div></div>`;
      } finally { q("#sttMinutes").disabled = false; }
    };

    async function recordToggle(stateEl, onDone) {
      if (rec && rec.state === "recording") { rec.stop(); return; }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: {
          echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
        } });
      } catch { toast("Нет доступа к микрофону"); return; }
      chunks = [];
      rec = new MediaRecorder(stream, { mimeType: "audio/webm", audioBitsPerSecond: 128000 });
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        onDone(new Blob(chunks, { type: "audio/webm" }));
      };
      rec.start();
      stateEl.textContent = "идёт запись… (нажми ещё раз для стопа)";
    }

    q("#recBtn").addEventListener("click", () => {
      const btn = q("#recBtn").querySelector("span");
      if (rec && rec.state === "recording") { btn.textContent = "Записать"; rec.stop(); return; }
      recordToggle(q("#recState"), (blob) => { btn.textContent = "Записать"; transcribeBlob(blob, "rec.webm"); });
      btn.textContent = "Стоп";
    });

    q("#fileBtn").addEventListener("click", () => q("#sttFile").click());
    q("#sttFile").addEventListener("change", () => {
      const f = q("#sttFile").files[0];
      if (f) transcribeBlob(f, f.name);
    });
    const dz = q("#dropZone");
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.style.background = "rgba(128,128,255,.08)"; });
    dz.addEventListener("dragleave", () => { dz.style.background = ""; });
    dz.addEventListener("drop", (e) => {
      e.preventDefault(); dz.style.background = "";
      const f = e.dataTransfer.files[0];
      if (f) transcribeBlob(f, f.name);
    });

    q("#sttTranslate").addEventListener("click", async () => {
      const text = q("#sttOut").value.trim();
      if (!text) { toast("Сначала распознай аудио или введи текст"); return; }
      const btn = q("#sttTranslate");
      const target = q("#sttTrLang").value;
      btn.disabled = true;
      const started = Date.now();
      const tick = setInterval(() => {
        q("#sttTrState").textContent = `перевожу… ${Math.round((Date.now() - started) / 1000)} с`;
      }, 500);
      q("#sttTrState").textContent = "перевожу…";
      try {
        const res = await fetch("/api/speech/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, target }),
        });
        if (!res.ok) throw new Error((await res.json()).error || res.status);
        const data = await res.json();
        q("#sttTrOut").value = data.text || "";
        q("#sttTrOut").style.display = "";
        q("#sttTrActions").style.display = "";
        q("#sttTrState").textContent = `готово за ${Math.round((Date.now() - started) / 1000)} с`;
      } catch (err) {
        q("#sttTrState").textContent = `ошибка: ${err.message}`;
        toast(`Перевод: ${esc(err.message)}`);
      } finally {
        clearInterval(tick);
        btn.disabled = false;
      }
    });

    // the whole point of the chain: translation goes straight into the voice
    q("#sttTrSpeak").addEventListener("click", () => {
      const text = q("#sttTrOut").value.trim();
      if (!text) { toast("Сначала переведи текст"); return; }
      const target = q("#sttTrLang").value;
      const voiced = { uz: "Uzbek", ru: "Russian", en: "English" }[target];
      if (!voiced) {
        toast("Голос есть для узбекского, русского и английского");
        return;
      }
      q("#ttsText").value = text;
      q("#ttsCount").textContent = text.length;
      q("#ttsLang").value = voiced;
      q("#ttsLang").dispatchEvent(new Event("change"));
      q("#ttsBtn").click();
      q("#ttsText").scrollIntoView({ behavior: "smooth", block: "center" });
    });

    q("#sttTrCopy").addEventListener("click", async () => {
      await navigator.clipboard.writeText(q("#sttTrOut").value);
      toast("Перевод скопирован");
    });

    q("#sttCopy").addEventListener("click", async () => {
      await navigator.clipboard.writeText(q("#sttOut").value);
      toast("Скопировано");
    });
    q("#sttTxt").addEventListener("click", () => download("transcript.txt", q("#sttOut").value, "text/plain"));
    q("#sttSrt").addEventListener("click", () => {
      if (!lastStt?.segments?.length) { toast("Сначала распознай аудио"); return; }
      download("subtitles.srt", toSrt(lastStt.segments), "text/plain");
    });
    q("#sttHist").addEventListener("click", async (e) => {
      const i = e.target.closest("[data-stt-copy]")?.dataset.sttCopy;
      if (i !== undefined) { await navigator.clipboard.writeText(sttHistory[i].text); toast("Скопировано"); }
    });

    // ---------- TTS ----------
    const engineUI = () => {
      const eng = q("#ttsEngine").value;
      // the picker belongs to the Qwen engines; Uzbek has our single trained voice
      const canPickVoice = (eng === "quality" || eng === "emotion")
        && q("#ttsLang").value !== "Uzbek";
      q("#ttsSpeaker").style.display = canPickVoice ? "" : "none";
      q("#ttsSpeakerLabel").style.display = canPickVoice ? "" : "none";
      q("#ttsInstruct").style.display = eng === "emotion" ? "" : "none";
      q("#cloneRow").style.display = eng === "clone" ? "" : "none";
      q("#speedRow").style.display = eng === "fast" ? "" : "none";
    };
    q("#ttsEngine").addEventListener("change", engineUI);
    q("#ttsLang").addEventListener("change", engineUI);
    q("#ttsSpeed").addEventListener("input", () => { q("#speedVal").textContent = `${Number(q("#ttsSpeed").value).toFixed(2)}x`; });
    q("#ttsText").addEventListener("input", () => { q("#ttsCount").textContent = q("#ttsText").value.length; });
    q("#ttsCount").textContent = q("#ttsText").value.length;

    q("#cloneRecBtn").addEventListener("click", () => {
      if (rec && rec.state === "recording") { rec.stop(); return; }
      recordToggle(q("#cloneState"), (blob) => {
        cloneSample = { blob, name: "sample.webm" };
        q("#cloneState").textContent = `образец записан (${Math.round(blob.size / 1024)} КБ)`;
      });
    });
    q("#cloneFileBtn").addEventListener("click", () => q("#cloneFile").click());
    q("#cloneFile").addEventListener("change", () => {
      const f = q("#cloneFile").files[0];
      if (f) { cloneSample = { blob: f, name: f.name }; q("#cloneState").textContent = `образец: ${f.name}`; }
    });

    function pushTtsHistory(text, mode, url) {
      ttsHistory.unshift({ text, mode, url, ts: Date.now() });
      q("#ttsHist").innerHTML = ttsHistoryHTML();
    }

    q("#ttsHist").addEventListener("click", (e) => {
      const play = e.target.closest("[data-tts-play]")?.dataset.ttsPlay;
      const dl = e.target.closest("[data-tts-dl]")?.dataset.ttsDl;
      if (play !== undefined) { const a = q("#ttsAudio"); a.src = ttsHistory[play].url; a.style.display = "block"; a.play(); }
      if (dl !== undefined) download("speech.wav", ttsHistory[dl].url);
    });

    q("#ttsBtn").addEventListener("click", async () => {
      const text = q("#ttsText").value.trim();
      if (!text) { toast("Введите текст"); return; }
      const engine = q("#ttsEngine").value;
      const btn = q("#ttsBtn");
      if (btn.disabled) return;                 // a second click would only queue
      // premium runs a diffusion model on CPU: ~13x realtime, plus ~50 s the
      // first time after a restart while the model loads
      const eta = { premium: 45, clone: 65, quality: 6, emotion: 6, fast: 1 }[engine] || 5;
      const started = Date.now();
      btn.disabled = true;
      const tick = () => {
        const el = Math.round((Date.now() - started) / 1000);
        q("#ttsState").textContent = eta > 3
          ? `генерирую… ${el} с (обычно около ${eta} с)`
          : "генерирую…";
      };
      tick();
      const ttsTicker = setInterval(tick, 1000);
      try {
        let res;
        if (engine === "clone") {
          if (!cloneSample) throw new Error("сначала задай образец голоса");
          if (!q("#cloneConsent").checked) throw new Error("подтверди согласие владельца голоса");
          const params = new URLSearchParams({ text, language: q("#ttsLang").value, consent: "true" });
          const refText = q("#cloneRefText").value.trim();
          if (refText) params.set("ref_text", refText);
          res = await fetch(`/api/speech/clone?${params}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(cloneSample.name) },
            body: cloneSample.blob,
          });
        } else {
          res = await fetch("/api/speech/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text, engine,
              language: q("#ttsLang").value,
              speaker: q("#ttsSpeaker").value,
              speed: engine === "fast" ? Number(q("#ttsSpeed").value) : undefined,
              instruct: engine === "emotion" ? q("#ttsInstruct").value.trim() : "",
            }),
          });
        }
        if (!res.ok) throw new Error((await res.json()).error || res.status);
        const bytes = await res.arrayBuffer();
        if (bytes.byteLength < 100) throw new Error("пустой аудио-ответ");
        const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
        const audio = q("#ttsAudio");
        audio.src = url;
        audio.style.display = "block";
        const dl = q("#ttsDl");
        dl.href = url; dl.download = "speech.wav"; dl.style.display = "";
        audio.play().catch(() => {});
        q("#ttsState").textContent = `готово (${Math.round(bytes.byteLength / 1024)} КБ)`;
        pushTtsHistory(text, engine, url);
      } catch (err) {
        q("#ttsState").textContent = `ошибка: ${err.message}`;
        toast(`TTS: ${esc(err.message)}`);
      } finally {
        clearInterval(ttsTicker);
        btn.disabled = false;
      }
    });
    engineUI();
  },

  unmount() {
    if (rec && rec.state === "recording") rec.stop();
    rec = null;
  },
};
