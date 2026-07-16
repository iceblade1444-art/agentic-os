import { api } from "../api.js";
import { icon } from "../icons.js";
import { store } from "../store.js";
import { esc, toast } from "../ui.js";
import { MilaLiveSession } from "../mila-live.js";

let session = null;
let history = [];
let partials = { user: "", assistant: "" };
let timer = null;
let startedAt = 0;

const PHASES = {
  checking: ["Checking", "neutral"], idle: ["Ready", "success"], connecting: ["Connecting", "warning"],
  listening: ["Listening", "success"], thinking: ["Thinking", "warning"], speaking: ["Speaking", "info"],
  muted: ["Muted", "neutral"], error: ["Unavailable", "error"],
};

const TOOLS = [{
  name: "delegate_to_hermes",
  description: "Start a confirmed task in Agentic OS using Hermes, the primary orchestrator.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short task title" },
      goal: { type: "string", description: "Complete task goal with relevant context" },
    },
    required: ["goal"],
  },
}];

function systemInstruction() {
  const recent = history.slice(-8).map((m) => `${m.role === "user" ? "User" : "Mila"}: ${m.text}`).join("\n");
  return `You are Mila, the live voice assistant inside Agentic OS. Hermes is the primary orchestrator and executes real work.
Reply in the language of the user's latest message. You are fluent in Russian, Uzbek and English.
Speak naturally and briefly, usually one to three sentences. Never read markdown, JSON, URLs or file paths aloud.
Say all numbers, dates, times and prices as words in the language you are speaking.
For conversation and simple factual questions, answer directly.
For any request that requires tools, files, research, deployment, automation or changes, briefly confirm the intended action first. Only after the user confirms, call delegate_to_hermes with a precise goal. Never claim that Hermes completed a task when it has only started.
Current local time: ${new Date().toISOString()}.
${recent ? `Recent conversation:\n${recent}` : ""}`;
}

function transcriptHTML() {
  const messages = [
    ...history,
    ...(partials.user ? [{ role: "user", text: partials.user, partial: true }] : []),
    ...(partials.assistant ? [{ role: "assistant", text: partials.assistant, partial: true }] : []),
  ];
  if (!messages.length) return `<div class="mila-empty"><span>${icon("mic")}</span><strong>No conversation yet</strong></div>`;
  return messages.map((message) => message.role === "system"
    ? `<div class="mila-event">${icon("brain")}<span>${esc(message.text)}</span></div>`
    : `<div class="mila-line ${message.role}${message.partial ? " partial" : ""}"><span class="mila-speaker">${message.role === "user" ? "You" : "Mila"}</span><p>${esc(message.text)}</p></div>`).join("");
}

function barsHTML() {
  return Array.from({ length: 31 }, (_, index) => `<i style="--bar:${index}"></i>`).join("");
}

export default {
  title: "Mila Live",
  render() {
    return `<div class="mila-live">
      <div class="page-head mila-head">
        <div><div class="page-title">Mila Live</div><div class="page-sub">Gemini Live voice · Hermes orchestrator</div></div>
        <div class="spacer"></div>
        <span class="badge neutral" id="milaStatus"><span class="dot"></span>Checking</span>
        <span class="badge neutral mono" id="milaTimer">00:00</span>
        <a class="icon-btn tip" data-tip="Mila integration" href="#/integrations">${icon("settings")}</a>
      </div>

      <div class="mila-grid">
        <section class="mila-stage" aria-label="Mila live voice">
          <div class="mila-identity">
            <span class="mila-mark">${icon("mic")}</span>
            <div class="stack"><strong>Mila</strong><span class="muted text-sm" id="milaModel">Voice backend</span></div>
            <span class="mila-handoff">${icon("brain")}Hermes</span>
          </div>

          <div class="mila-wave" id="milaWave" aria-hidden="true">${barsHTML()}</div>
          <div class="mila-phase" id="milaPhase">Ready</div>
          <div class="mila-caption" id="milaCaption" aria-live="polite"></div>

          <div class="mila-controls">
            <button class="mila-mic tip" id="milaMic" data-tip="Start live call" aria-label="Start live call">${icon("mic")}</button>
            <button class="mila-end tip hidden" id="milaEnd" data-tip="End call" aria-label="End call">${icon("x")}</button>
          </div>

          <div class="mila-meters">
            <span>${icon("mic")}<i><b id="milaInputLevel"></b></i></span>
            <span>${icon("activity")}<i><b id="milaOutputLevel"></b></i></span>
          </div>

          <form class="mila-composer" id="milaComposer">
            <input id="milaText" maxlength="1000" placeholder="Message Mila…" autocomplete="off"/>
            <button class="icon-btn tip" data-tip="Send" aria-label="Send" type="submit">${icon("send")}</button>
          </form>
        </section>

        <section class="mila-transcript" aria-label="Live transcript">
          <div class="mila-transcript-head"><div><strong>Transcript</strong><span>Live session</span></div><button class="icon-btn tip" id="milaClear" data-tip="Clear transcript" aria-label="Clear transcript">${icon("trash")}</button></div>
          <div class="mila-scroll" id="milaScroll" aria-live="polite">${transcriptHTML()}</div>
        </section>
      </div>
      <div class="alert error hidden" id="milaError"><span class="a-ico">${icon("warn")}</span><div class="a-body"><div class="a-title">Mila Live unavailable</div><div class="a-desc" id="milaErrorText"></div></div></div>
    </div>`;
  },

  mount(root) {
    const status = root.querySelector("#milaStatus");
    const phase = root.querySelector("#milaPhase");
    const caption = root.querySelector("#milaCaption");
    const scroll = root.querySelector("#milaScroll");
    const mic = root.querySelector("#milaMic");
    const end = root.querySelector("#milaEnd");
    const text = root.querySelector("#milaText");
    const errorBox = root.querySelector("#milaError");
    const inputMeter = root.querySelector("#milaInputLevel");
    const outputMeter = root.querySelector("#milaOutputLevel");
    let backendReady = false;
    let currentPhase = "checking";

    const drawTranscript = () => {
      scroll.innerHTML = transcriptHTML();
      scroll.scrollTop = scroll.scrollHeight;
      caption.textContent = partials.assistant || partials.user || "";
    };
    const drawPhase = (next, message = "") => {
      currentPhase = next;
      const [label, cls] = PHASES[next] || PHASES.idle;
      phase.textContent = label;
      status.className = `badge ${cls}`;
      status.innerHTML = `<span class="dot"></span>${label}`;
      root.querySelector(".mila-stage").dataset.phase = next;
      if (message) {
        errorBox.classList.remove("hidden");
        root.querySelector("#milaErrorText").textContent = message;
      } else errorBox.classList.add("hidden");
      const active = ["listening", "thinking", "speaking", "muted"].includes(next);
      end.classList.toggle("hidden", !active && next !== "connecting");
      mic.dataset.tip = active ? (next === "muted" ? "Unmute" : "Mute") : "Start live call";
      mic.setAttribute("aria-label", mic.dataset.tip);
      mic.classList.toggle("muted", next === "muted");
    };
    const setLevel = (kind, value) => {
      const amount = Math.max(0, Math.min(1, value || 0));
      (kind === "input" ? inputMeter : outputMeter).style.width = `${Math.round(amount * 100)}%`;
      const bars = root.querySelectorAll("#milaWave i");
      bars.forEach((bar, index) => {
        const distance = Math.abs(index - (bars.length - 1) / 2) / (bars.length / 2);
        const shape = Math.max(0.12, 1 - distance * 0.72);
        const motion = 0.55 + Math.abs(Math.sin(index * 1.7 + Date.now() / 180)) * 0.45;
        bar.style.height = `${Math.max(5, Math.round(8 + amount * 78 * shape * motion))}px`;
      });
    };
    const addSystem = (message) => {
      history.push({ role: "system", text: message });
      drawTranscript();
    };
    const startTimer = () => {
      startedAt = Date.now();
      clearInterval(timer);
      timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        root.querySelector("#milaTimer").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
      }, 1000);
    };
    const stopTimer = () => {
      clearInterval(timer);
      timer = null;
      startedAt = 0;
      root.querySelector("#milaTimer").textContent = "00:00";
    };

    async function delegateToHermes(_name, args) {
      const goal = String(args.goal || "").trim();
      if (!goal) throw new Error("Hermes needs a task goal");
      const title = String(args.title || goal).trim().slice(0, 100);
      const mission = await api.missions.create({ title, goal, orchestrator: "hermes" });
      addSystem(`Sent to Hermes: ${title}`);
      api.missions.run(mission.id, (event) => {
        if (event.type === "complete") addSystem(`Hermes completed: ${event.message || title}`);
        if (event.type === "approval_required") addSystem(`Hermes needs approval: ${title}`);
      }).catch((error) => addSystem(`Hermes failed: ${error.message}`));
      return { status: "started", missionId: mission.id, title };
    }

    async function startCall() {
      if (!backendReady || session) return;
      session = new MilaLiveSession({
        model: root.querySelector("#milaModel").dataset.model,
        voiceName: "Aoede",
        systemInstruction: systemInstruction(),
        tools: TOOLS,
        getToken: () => api.integrations.milaVoiceToken(),
        onState: ({ phase: next, error }) => {
          drawPhase(next, error);
          if (next === "listening" && !startedAt) startTimer();
          if (next === "idle" || next === "error") { stopTimer(); session = null; }
        },
        onLevel: setLevel,
        onPartial: (role, value) => { partials[role] = value; drawTranscript(); },
        onTurn: ({ user, assistant }) => {
          if (user) history.push({ role: "user", text: user });
          if (assistant) history.push({ role: "assistant", text: assistant });
          partials = { user: "", assistant: "" };
          drawTranscript();
        },
        onToolCall: delegateToHermes,
      });
      try { await session.start(); }
      catch (error) { toast("error", "Mila Live", error.message); session = null; }
    }

    mic.onclick = async () => {
      if (!session) return startCall();
      const muted = session.toggleMute();
      toast("info", "Mila Live", muted ? "Microphone muted" : "Microphone active");
    };
    end.onclick = async () => {
      const active = session;
      session = null;
      await active?.stop();
      stopTimer();
      drawPhase("idle");
      setLevel("input", 0); setLevel("output", 0);
    };
    root.querySelector("#milaComposer").onsubmit = (event) => {
      event.preventDefault();
      const value = text.value.trim();
      if (!value) return;
      if (!session || !["listening", "thinking", "speaking", "muted"].includes(currentPhase)) return toast("info", "Mila Live", "Start a live call first");
      try { session.sendText(value); text.value = ""; }
      catch (error) { toast("error", "Mila Live", error.message); }
    };
    root.querySelector("#milaClear").onclick = () => { history = []; partials = { user: "", assistant: "" }; drawTranscript(); };

    api.integrations.milaStatus().then((result) => {
      backendReady = !!result.voiceConfigured;
      const model = result.liveModel || "gemini-3.1-flash-live-preview";
      const modelEl = root.querySelector("#milaModel");
      modelEl.textContent = model;
      modelEl.dataset.model = model;
      drawPhase(backendReady ? "idle" : "error", backendReady ? "" : "Gemini Live is not configured in the Mila backend");
    }).catch((error) => drawPhase("error", error.message));
    drawTranscript();
  },

  unmount() {
    clearInterval(timer);
    timer = null;
    startedAt = 0;
    const active = session;
    session = null;
    active?.stop();
  },
};
