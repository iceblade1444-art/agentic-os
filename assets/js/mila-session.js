import { api } from "./api.js";
import { MilaLiveSession } from "./mila-live.js";
import { MILA_MEMBER_TOOLS, MILA_TOOLS } from "./mila-tools.js";
import { knowledgePromptIndex } from "./knowledge-pages.js";
import {
  attachmentDisplayText, composeAttachmentPrompt, publicAttachment,
} from "./mila-attachments.js";
import {
  AGENT_CONTEXT_LIMIT, MILA_DEFAULT_PREFERENCES, MILA_LANGUAGES, buildMilaSystemInstruction, milaTokenPlan, normalizeMilaPreferences,
} from "./mila-prompt.js";

// The prompt lives in mila-prompt.js so the server can serve the same one to the
// voice agent. Re-exported here so existing importers keep their single import.
export {
  MILA_DEFAULT_PREFERENCES, MILA_DELIVERIES, MILA_LANGUAGES, MILA_LISTENING_PROFILES,
  MILA_PACES, MILA_PERSONA_LIMIT, MILA_RESPONSE_LENGTHS, MILA_STYLES, MILA_TRANSPORTS,
  MILA_VOICES, MILA_VOICE_DIRECTION_LIMIT, MILA_VOICE_GROUPS,
  buildMilaSystemInstruction, milaTokenPlan, normalizeMilaPreferences,
} from "./mila-prompt.js";


const ACTIVE_PHASES = new Set(["connecting", "listening", "thinking", "speaking", "muted"]);
function initialLanguage() {
  try {
    const value = localStorage.getItem("aos_mila_language");
    if (MILA_LANGUAGES.some(([code]) => code === value)) return value;
    const browserLanguage = navigator.language || "";
    if (browserLanguage.startsWith("uz")) return "uz-UZ";
    if (browserLanguage.startsWith("en")) return "en-US";
  } catch { /* storage unavailable */ }
  return "ru-RU";
}

function initialPreferences() {
  try {
    return normalizeMilaPreferences(JSON.parse(localStorage.getItem("aos_mila_preferences") || "{}"));
  } catch {
    return normalizeMilaPreferences();
  }
}

function now() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatElapsed(seconds = 0) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

const ERP_INTENT_RE = /(erp|склад|готов(ых|ая|ое|ые)?\s*(издел|продукц|товар)|готовая\s+продукция|warehouse|finished\s*goods|ready\s*product|остатк|производств|раскрой|закрой|пошив|упаковк|швейн|поток|заказ|срок|когда.*склад|inventory|stock|production|cutting|sewing|packag)/i;
const FINISHED_GOODS_RE = /(готов(ых|ая|ое|ые)?\s*(издел|продукц|товар)|готовая\s+продукция|склад\s+готов|finished\s*goods|ready\s*product|warehouse\s*stock)/i;

function safeJson(value, max = 9000) {
  try { return JSON.stringify(value, null, 2).slice(0, max); }
  catch { return String(value || "").slice(0, max); }
}

function buildErpContextPrompt(userText, context) {
  if (!context) return "";
  const facts = context.facts || context.finished_goods_facts || context.finished_goods_stock?.answer_hints || {};
  const summary = context.answer_summary || facts.answer_summary || "";
  return `
LIVE ERP CONTEXT FOR THE USER'S CURRENT QUESTION:
${summary}

Strict rules:
- Use ONLY this live ERP payload for ERP facts in the next answer.
- For finished-goods / ready-product warehouse questions, answer from facts.ready_goods_total_pieces or finished_goods_stock.total_pieces only.
- Finished-goods source of truth is /warehouse-stock + /warehouse-map, backed by /api/packages/storage-map.
- Do not use production output, sewing output, packaging output, material inventory, GM summary, old memory, or guesses as finished-goods warehouse stock.
- If the required field is absent or ok=false, say that the ERP value is not available instead of inventing it.

User question:
${String(userText || "").slice(0, 1000)}

Live ERP payload:
${safeJson(context)}
`.trim();
}

function unwrapErpCard(card) {
  if (!card || typeof card !== "object") return card || null;
  return card.data || card.result?.data || card.result || card;
}

function erpContextFromSnapshot(userText, snapshot = {}) {
  const cards = snapshot.cards || {};
  const finishedGoods = unwrapErpCard(cards.erp_finished_goods_stock);
  const control = unwrapErpCard(cards.erp_business_control);
  const production = unwrapErpCard(cards.erp_active_production);
  const inventory = unwrapErpCard(cards.erp_inventory_status);
  const finance = unwrapErpCard(cards.erp_finance_summary);
  const finishedHints = finishedGoods?.answer_hints || {};
  const finishedFacts = {
    ready_goods_total_pieces: finishedGoods?.total_pieces ?? finishedHints.ready_goods_total_pieces ?? null,
    total_packages: finishedGoods?.total_packages ?? finishedHints.ready_goods_packages ?? null,
    total_models: finishedGoods?.total_models ?? finishedGoods?.models_count ?? null,
    source: finishedGoods?.source || "/api/packages/storage-map",
    source_page: finishedGoods?.source_page || "/warehouse-stock",
    map_page: finishedGoods?.map_page || "/warehouse-map",
    top_ready_goods_model: finishedHints.top_ready_goods_model || finishedGoods?.top_models?.[0] || null,
  };
  const answerSummary = finishedFacts.ready_goods_total_pieces == null
    ? "Finished-goods warehouse stock is missing from the live ERP snapshot; do not guess."
    : `Finished-goods warehouse stock: ${finishedFacts.ready_goods_total_pieces} pcs, ${finishedFacts.total_packages ?? "-"} packages, ${finishedFacts.total_models ?? "-"} models. Source: /warehouse-stock + /warehouse-map.`;
  const context = {
    ok: !!snapshot.ok,
    source_policy: "This payload is the Agentic OS ERP panel live snapshot. Answer ERP questions only from these fields. For finished-goods warehouse questions use finished_goods_facts.ready_goods_total_pieces or finished_goods_stock.total_pieces only.",
    facts: finishedFacts,
    answer_summary: answerSummary,
    finished_goods_stock: finishedGoods,
    business_control: control,
    production,
    material_inventory: inventory,
    finance,
    errors: snapshot.errors || {},
    server: snapshot.server || {},
  };
  if (FINISHED_GOODS_RE.test(String(userText || ""))) return context;
  return {
    ...context,
    answer_hints: {
      busiest_sewing_flow: control?.answer_hints?.busiest_sewing_flow || null,
      next_warehouse_order: control?.answer_hints?.next_warehouse_order || null,
      finished_goods_stock: finishedGoods?.answer_hints || null,
    },
  };
}

function buildErpBaselinePrompt(context) {
  if (!context) return "";
  return `
LIVE ERP BASELINE FOR THIS VOICE CALL:
${context.answer_summary || "ERP baseline is loaded, but finished-goods facts are missing."}

Strict rules:
- This baseline comes from the Agentic OS ERP panel at call start.
- For finished-goods / ready-product warehouse questions, use facts.ready_goods_total_pieces or finished_goods_stock.total_pieces.
- Finished-goods source of truth is /warehouse-stock + /warehouse-map, backed by /api/packages/storage-map.
- Do not use production output, sewing output, packaging output, material inventory, GM summary, old memory, or guesses as finished-goods warehouse stock.
- If a live ERP tool result is available later, prefer that newer tool result over this baseline.
- If neither this baseline nor a tool result contains the required field, say the ERP value is not available instead of inventing it.

Live ERP baseline payload:
${safeJson(context)}
`.trim();
}

class MilaSessionHub {
  constructor() {
    this.session = null;
    // start() awaits the status probe and the ERP snapshot before it can claim
    // this.session, so without this a second click during that window opened a
    // second live socket that stop() could no longer reach.
    this.startPromise = null;
    this.listeners = new Set();
    this.statusPromise = null;
    this.timer = null;
    this.claudeWatchers = new Set();
    this.voiceTiming = { thinkingAt: 0, speakingAt: 0 };
    this.state = {
      phase: "checking", error: "", backendReady: false,
      model: "gemini-3.1-flash-live-preview", language: initialLanguage(),
      preferences: initialPreferences(),
      agentContext: "",
      transcriptionMode: "gemini", transcriptWarning: 0,
      history: [], partials: { user: "", assistant: "" }, pendingTurnAttachments: [],
      inputLevel: 0, outputLevel: 0, startedAt: 0, elapsed: 0, elapsedLabel: "00:00",
      sendingTurn: false,
      textPhase: "idle", textError: "", videoSource: "off",
    };
  }

  get active() {
    return !!this.session && ACTIVE_PHASES.has(this.state.phase);
  }

  snapshot() {
    return { ...this.state, active: this.active, starting: !!this.startPromise };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  notify() {
    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  async loadStatus(force = false) {
    if (this.statusPromise && !force) return this.statusPromise;
    this.statusPromise = Promise.all([
      api.integrations.milaStatus(),
      api.onboarding.get().catch(() => ({ agentContext: "" })),
    ]).then(([result, onboarding]) => {
      this.state.agentContext = String(onboarding.agentContext || "").slice(0, AGENT_CONTEXT_LIMIT);
      this.state.backendReady = !!result.voiceConfigured;
      this.state.model = result.liveModel || this.state.model;
      this.state.phase = this.state.backendReady ? "idle" : "error";
      this.state.error = this.state.backendReady ? "" : "Gemini Live is not configured in the Mila backend";
      this.notify();
      return result;
    }).catch((error) => {
      this.state.backendReady = false;
      this.state.phase = "error";
      this.state.error = error.message || "Mila backend is unavailable";
      this.notify();
      throw error;
    });
    return this.statusPromise;
  }

  setLanguage(language) {
    if (this.active || !MILA_LANGUAGES.some(([code]) => code === language)) return false;
    this.state.language = language;
    this.state.transcriptWarning = 0;
    try { localStorage.setItem("aos_mila_language", language); } catch { /* storage unavailable */ }
    this.notify();
    return true;
  }

  setPreferences(preferences) {
    if (this.active) return false;
    this.state.preferences = normalizeMilaPreferences(preferences);
    try { localStorage.setItem("aos_mila_preferences", JSON.stringify(this.state.preferences)); } catch { /* storage unavailable */ }
    this.notify();
    return true;
  }

  // The tools this surface actually declares to the model, so the prompt never
  // describes an action the session cannot perform.
  get declaredTools() {
    return api.auth.canAdmin ? MILA_TOOLS : MILA_MEMBER_TOOLS;
  }

  systemInstruction(mode = "voice") {
    return buildMilaSystemInstruction({
      language: this.state.language,
      preferences: this.state.preferences,
      history: this.state.history,
      agentContext: this.state.agentContext,
      mode,
      tools: this.declaredTools.map((tool) => tool.name),
      knowledgeIndex: knowledgePromptIndex(),
    });
  }

  async liveSystemInstruction() {
    try {
      const baseline = erpContextFromSnapshot("voice call ERP baseline", await api.erp.snapshot());
      return [this.systemInstruction("voice"), buildErpBaselinePrompt(baseline)].filter(Boolean).join("\n\n");
    } catch {
      return this.systemInstruction("voice");
    }
  }

  async erpContextFor(text) {
    const value = String(text || "");
    if (!ERP_INTENT_RE.test(value)) return "";
    try {
      const context = erpContextFromSnapshot(value, await api.erp.snapshot());
      return buildErpContextPrompt(value, context);
    } catch (error) {
      return `
LIVE ERP CONTEXT FOR THE USER'S CURRENT QUESTION:
Agentic OS tried to read live ERP data, but the ERP tool failed: ${error.message || "unknown error"}.
Strict rule: do not invent ERP numbers. Tell the user the ERP data could not be verified live and suggest retrying from the ERP panel.
`.trim();
    }
  }

  // Writing does not use the Live socket: live models answer in audio only, so
  // the written channel goes to MILA's Gemini chat endpoint, which takes text
  // and inline images in one request.
  async sendWritten(text, attachments = []) {
    let optimistic = null;
    try {
      if (this.state.phase === "checking") await this.loadStatus();
      if (!this.state.backendReady) throw new Error(this.state.error || "Mila is not configured");
      const prompt = composeAttachmentPrompt(text, attachments, this.state.language);
      const images = attachments.filter((item) => item.kind === "image")
        .map((item) => ({ mimeType: item.type || "image/jpeg", data: item.data }));

      // Show the question immediately, but take it back if it never got through,
      // so a retry does not leave the same message in the transcript twice.
      optimistic = {
        role: "user",
        text: attachmentDisplayText(text, attachments, this.state.language),
        attachments: attachments.map(publicAttachment),
        at: now(),
      };
      this.state.history.push(optimistic);
      this.state.textPhase = "thinking";
      this.state.textError = "";
      this.notify();

      const erpContext = await this.erpContextFor(text);
      const result = await api.integrations.milaChat({
        systemPrompt: [this.systemInstruction("text"), erpContext].filter(Boolean).join("\n\n"),
        messages: [
          ...this.state.history.slice(-13, -1)
            .filter((item) => item.role !== "system")
            .map((item) => ({ role: item.role, content: item.text })),
          { role: "user", content: prompt, attachments: images },
        ],
      });
      this.state.history.push({ role: "assistant", text: result.text || "", at: now() });
      this.state.textPhase = "idle";
    } catch (error) {
      if (optimistic) this.state.history = this.state.history.filter((item) => item !== optimistic);
      this.state.textPhase = "error";
      this.state.textError = error.message || "Mila could not answer";
      throw error;
    } finally {
      this.state.sendingTurn = false;
      this.notify();
    }
  }

  async setVideo(source) {
    if (!this.session || !this.active) throw new Error("Start a call before sharing video");
    if (source === "off") {
      await this.session.stopVideo();
      return "off";
    }
    return this.session.startVideo(source);
  }

  // Callers may click the mic repeatedly; every one of them awaits the single
  // in-flight attempt instead of opening a socket of its own.
  start() {
    if (this.session) return Promise.resolve();
    if (!this.startPromise) {
      this.startPromise = this.#start().finally(() => { this.startPromise = null; this.notify(); });
      this.notify();
    }
    return this.startPromise;
  }

  async #start() {
    if (this.state.phase === "checking") await this.loadStatus();
    if (!this.state.backendReady) throw new Error(this.state.error || "Mila Live is not configured");

    let live;
    live = new MilaLiveSession({
      model: this.state.model,
      voiceName: this.state.preferences.voiceName,
      affectiveDialog: this.state.preferences.affectiveDialog,
      proactiveAudio: this.state.preferences.proactiveAudio,
      listeningProfile: this.state.preferences.listeningProfile,
      transcriptionLanguage: this.state.language,
      inputDeviceId: this.state.preferences.inputDeviceId,
      systemInstruction: await this.liveSystemInstruction(),
      tools: this.declaredTools,
      getToken: async () => {
        const body = { language: this.state.language };
        const mint = {
          livekit: () => api.integrations.milaLiveKitToken(body),
          direct: () => api.integrations.milaVoiceToken(body),
        };
        let lastError;
        for (const step of milaTokenPlan(this.state.preferences.transport)) {
          try { return await mint[step](); }
          catch (error) { lastError = error; }
        }
        throw lastError || new Error("Mila did not return a Live token");
      },
      onState: ({ phase, error }) => this.handleState(live, phase, error),
      onLevel: (kind, value) => {
        this.state[kind === "input" ? "inputLevel" : "outputLevel"] = Math.max(0, Math.min(1, value || 0));
        this.notify();
      },
      onTranscriptionMode: (mode) => { this.state.transcriptionMode = mode; this.notify(); },
      onVideo: ({ source }) => { this.state.videoSource = source; this.notify(); },
      onTranscriptWarning: () => {
        this.state.transcriptWarning += 1;
        this.state.partials.user = "";
        this.metric("stt_warning");
        this.notify();
      },
      onPartial: (role, value) => { this.state.partials[role] = value; this.notify(); },
      onTurn: ({ user, assistant }) => {
        if (user) this.state.history.push({ role: "user", text: user, attachments: this.state.pendingTurnAttachments, at: now() });
        if (assistant) this.state.history.push({ role: "assistant", text: assistant, at: now() });
        this.state.pendingTurnAttachments = [];
        this.state.partials = { user: "", assistant: "" };
        this.state.sendingTurn = false;
        this.notify();
      },
      onToolCall: (name, args) => this.runAgenticAction(name, args),
    });
    this.session = live;
    try {
      await live.start();
      this.metric("session_started");
    } catch (error) {
      if (this.session === live) this.session = null;
      this.state.phase = "error";
      this.state.error = error.message || "Could not start Mila Live";
      this.metric("session_error");
      this.stopTimer();
      this.notify();
      throw error;
    }
  }

  handleState(live, phase, error = "") {
    if (live !== this.session && phase !== "connecting") return;
    const previous = this.state.phase;
    this.state.phase = phase;
    this.state.error = error || "";
    if (phase === "listening" && !this.state.startedAt) this.startTimer();
    if (phase === "thinking" && previous !== "thinking") {
      this.voiceTiming.thinkingAt = Date.now();
      this.metric("turn_input");
    }
    if (phase === "speaking" && previous !== "speaking") {
      this.voiceTiming.speakingAt = Date.now();
      this.metric("turn_response", this.voiceTiming.thinkingAt ? Date.now() - this.voiceTiming.thinkingAt : null);
    }
    if (phase === "listening" && previous === "speaking") {
      this.metric("turn_completed", this.voiceTiming.speakingAt ? Date.now() - this.voiceTiming.speakingAt : null);
      this.voiceTiming = { thinkingAt: 0, speakingAt: 0 };
    }
    if (phase === "idle") {
      if (this.session === live) this.session = null;
      this.state.sendingTurn = false;
      this.state.pendingTurnAttachments = [];
      this.state.videoSource = "off";
      this.stopTimer();
    }
    if (phase === "error") {
      this.metric("session_error");
      const shouldCleanup = this.session === live && !!this.state.startedAt;
      if (this.session === live) this.session = null;
      this.state.sendingTurn = false;
      this.state.pendingTurnAttachments = [];
      this.state.videoSource = "off";
      this.stopTimer();
      if (shouldCleanup) {
        const savedError = this.state.error;
        queueMicrotask(async () => {
          await live.stop();
          if (!this.session) {
            this.state.phase = "error";
            this.state.error = savedError;
            this.notify();
          }
        });
      }
    }
    this.notify();
  }

  metric(event, valueMs = null) {
    api.voiceMetric({
      event,
      valueMs,
      transport: this.state.preferences.transport,
      model: this.state.model,
      language: this.state.language,
    }).catch(() => {});
  }

  startTimer() {
    this.state.startedAt = Date.now();
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.state.elapsed = Math.floor((Date.now() - this.state.startedAt) / 1000);
      this.state.elapsedLabel = formatElapsed(this.state.elapsed);
      this.notify();
    }, 1000);
  }

  stopTimer() {
    clearInterval(this.timer);
    this.timer = null;
    this.state.startedAt = 0;
    this.state.elapsed = 0;
    this.state.elapsedLabel = "00:00";
    this.state.inputLevel = 0;
    this.state.outputLevel = 0;
  }

  toggleMute() {
    if (!this.session) throw new Error("Start a live call first");
    return this.session.toggleMute();
  }

  async stop() {
    // "End call" pressed while the socket is still opening: wait for the attempt
    // to claim this.session, otherwise it would connect just after we cleared it.
    if (this.startPromise) await this.startPromise.catch(() => {});
    const live = this.session;
    this.session = null;
    if (live) await live.stop();
    if (live) this.metric("session_ended");
    this.state.phase = this.state.backendReady ? "idle" : "error";
    this.state.error = this.state.backendReady ? "" : this.state.error;
    this.state.transcriptionMode = "gemini";
    this.state.partials = { user: "", assistant: "" };
    this.state.sendingTurn = false;
    this.state.pendingTurnAttachments = [];
    this.stopTimer();
    this.notify();
  }

  async sendTurn(text, attachments = []) {
    if (this.state.sendingTurn) throw new Error("Wait for the current turn to finish");
    this.state.sendingTurn = true;
    // During a call the words join the call and Mila speaks the answer — over
    // the direct socket as client content, over LiveKit on the agent's chat
    // topic. Only pictures cannot ride the LiveKit channel, and with no call at
    // all there is nothing to speak into: both take the written channel.
    const onLiveKit = this.active && this.session?.usingLiveKit;
    const hasImages = attachments.some((item) => item.kind === "image");
    if (!this.active || !this.session || (onLiveKit && hasImages)) {
      this.notify();
      return this.sendWritten(text, attachments);
    }
    this.state.pendingTurnAttachments = attachments.map(publicAttachment);
    this.notify();
    try {
      await this.session.sendTurn({
        prompt: composeAttachmentPrompt(text, attachments, this.state.language),
        displayText: attachmentDisplayText(text, attachments, this.state.language),
        images: attachments.filter((item) => item.kind === "image"),
      });
    } catch (error) {
      this.state.pendingTurnAttachments = [];
      this.state.sendingTurn = false;
      this.notify();
      throw error;
    }
  }

  clearHistory() {
    this.state.history = [];
    this.state.partials = { user: "", assistant: "" };
    this.notify();
  }

  addSystem(message) {
    this.state.history.push({ role: "system", text: message, at: now() });
    this.notify();
  }

  async runAgenticAction(name, args = {}) {
    const result = await api.mila.action(name, args);
    if (result.confirmationRequired) {
      this.addSystem(`Waiting for confirmation: ${result.summary}`);
      return result;
    }
    if (name === "delegate_to_hermes") this.addSystem(`Hermes accepted Kanban task: ${result.task?.title || "New task"}`);
    if (name === "create_kanban_task") this.addSystem(`Kanban task created: ${result.task?.title || "New task"}`);
    if (name === "write_obsidian_note") this.addSystem(`Obsidian updated: ${result.note?.path || "note"}`);
    if (name === "ask_claude_code") {
      this.addSystem(`Claude Workspace started: ${result.title || "Coding task"}`);
      this.watchClaude(result.sessionId, result.title);
    }
    return result;
  }

  watchClaude(sessionId, title = "Coding task") {
    if (!sessionId || this.claudeWatchers.has(sessionId)) return;
    this.claudeWatchers.add(sessionId);
    let attempts = 0;
    const poll = async () => {
      attempts++;
      try {
        const session = await api.claude.session(sessionId);
        if (session.status === "running" && attempts < 180) return setTimeout(poll, 4000);
        const latest = (session.messages || []).filter((item) => item.role === "assistant").at(-1);
        if (session.status === "ready") this.addSystem(`Claude completed ${title}: ${String(latest?.text || "Result is ready in Claude Workspace").slice(0, 500)}`);
        else this.addSystem(`Claude stopped ${title}: ${String(latest?.text || session.status || "unknown status").slice(0, 300)}`);
      } catch (error) {
        if (attempts < 5) return setTimeout(poll, 4000);
        this.addSystem(`Could not read Claude task status: ${error.message}`);
      }
      this.claudeWatchers.delete(sessionId);
    };
    setTimeout(poll, 2500);
  }
}

export const milaHub = new MilaSessionHub();
