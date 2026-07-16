const LIVE_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pcm16FromFloat(input, sourceRate) {
  const ratio = sourceRate / INPUT_RATE;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(output.buffer);
}

function rmsFloat(input) {
  if (!input.length) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i += 4) sum += input[i] * input[i];
  return Math.min(1, Math.sqrt(sum / Math.max(1, input.length / 4)) * 4);
}

function rmsPcm16(bytes) {
  if (bytes.length < 2) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 1 < bytes.length; i += 8) {
    const value = view.getInt16(i, true) / 32768;
    sum += value * value;
    count++;
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, count)) * 3);
}

export class MilaLiveSession {
  constructor(options) {
    this.options = options;
    this.socket = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.processor = null;
    this.inputSource = null;
    this.silentGain = null;
    this.playbackSources = new Set();
    this.nextPlaybackTime = 0;
    this.ready = false;
    this.muted = false;
    this.intentionalClose = false;
    this.currentUser = "";
    this.currentAssistant = "";
    this.readyResolve = null;
    this.readyReject = null;
  }

  async start() {
    this.intentionalClose = false;
    this._state("connecting");
    try {
      await this._openAudio();
      const credentials = await this.options.getToken();
      if (!credentials?.token) throw new Error("Mila did not return a Live token");
      await this._connect(credentials.token);
    } catch (error) {
      await this._cleanupAudio();
      this._state("error", error.message || "Could not start Mila Live");
      throw error;
    }
  }

  async stop() {
    this.intentionalClose = true;
    this.ready = false;
    this._commitTurn();
    this._clearPlayback();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, "Session ended");
    this.socket = null;
    await this._cleanupAudio();
    this._state("idle");
  }

  toggleMute() {
    this.muted = !this.muted;
    for (const track of this.mediaStream?.getAudioTracks() || []) track.enabled = !this.muted;
    this._state(this.muted ? "muted" : "listening");
    return this.muted;
  }

  sendText(text) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) throw new Error("Mila Live is not connected");
    this.currentUser = text;
    this.options.onPartial?.("user", text);
    this.socket.send(JSON.stringify({ realtimeInput: { text } }));
    this._state("thinking");
  }

  async _openAudio() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is unavailable in this browser");
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio is unavailable in this browser");
    this.audioContext = new AudioContextClass({ latencyHint: "interactive" });
    await this.audioContext.resume();
    this.inputSource = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioContext.createScriptProcessor(2048, 1, 1);
    this.silentGain = this.audioContext.createGain();
    this.silentGain.gain.value = 0;
    this.inputSource.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.audioContext.destination);
    this.processor.onaudioprocess = (event) => {
      if (!this.ready || this.muted || this.socket?.readyState !== WebSocket.OPEN) return;
      const samples = event.inputBuffer.getChannelData(0);
      this.options.onLevel?.("input", rmsFloat(samples));
      const pcm = pcm16FromFloat(samples, this.audioContext.sampleRate);
      this.socket.send(JSON.stringify({
        realtimeInput: { audio: { data: bytesToBase64(pcm), mimeType: `audio/pcm;rate=${INPUT_RATE}` } },
      }));
    };
  }

  async _connect(token) {
    const socket = new WebSocket(`${LIVE_ENDPOINT}?access_token=${encodeURIComponent(token)}`);
    this.socket = socket;
    const ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const timeout = setTimeout(() => this.readyReject?.(new Error("Mila Live connection timed out")), 12000);
    socket.onopen = () => {
      socket.send(JSON.stringify({
        setup: {
          model: `models/${this.options.model}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.options.voiceName || "Aoede" } } },
          },
          systemInstruction: { parts: [{ text: this.options.systemInstruction }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: { slidingWindow: {} },
          tools: [{ functionDeclarations: this.options.tools || [] }],
        },
      }));
    };
    socket.onmessage = (event) => this._handleFrame(event.data);
    socket.onerror = () => this.readyReject?.(new Error("Gemini Live WebSocket failed"));
    socket.onclose = (event) => {
      this.ready = false;
      if (!this.intentionalClose) this._state("error", event.reason || "Mila Live disconnected");
    };
    try {
      await ready;
    } finally {
      clearTimeout(timeout);
      this.readyResolve = null;
      this.readyReject = null;
    }
  }

  async _handleFrame(frame) {
    let text = frame;
    if (frame instanceof Blob) text = await frame.text();
    if (frame instanceof ArrayBuffer) text = new TextDecoder().decode(frame);
    let message;
    try { message = JSON.parse(text); } catch { return; }

    if (message.setupComplete) {
      this.ready = true;
      this._state("listening");
      this.readyResolve?.();
      return;
    }

    const content = message.serverContent;
    if (content) {
      if (content.interrupted) {
        this._clearPlayback();
        this._commitTurn();
        this._state("listening");
      }
      const userText = content.inputTranscription?.text;
      if (userText) {
        this.currentUser += userText;
        this.options.onPartial?.("user", this.currentUser);
        if (!this.currentAssistant) this._state("thinking");
      }
      const assistantText = content.outputTranscription?.text;
      if (assistantText) {
        this.currentAssistant += assistantText;
        this.options.onPartial?.("assistant", this.currentAssistant);
      }
      this._emitAudio(content.modelTurn);
      if (content.turnComplete) this._commitTurn();
    }

    if (message.toolCall) await this._handleTools(message.toolCall);
  }

  async _handleTools(toolCall) {
    this._state("thinking");
    const responses = [];
    for (const call of toolCall.functionCalls || []) {
      try {
        const result = await this.options.onToolCall?.(call.name, call.args || {});
        responses.push({ name: call.name, id: call.id, response: { result: result || { ok: true } } });
      } catch (error) {
        responses.push({ name: call.name, id: call.id, response: { error: error.message || "Tool failed" } });
      }
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    }
  }

  _emitAudio(value) {
    if (Array.isArray(value)) {
      for (const item of value) this._emitAudio(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const inline = value.inlineData || value.inline_data;
    if (inline?.data && (!inline.mimeType || inline.mimeType.includes("audio"))) this._play(base64ToBytes(inline.data));
    for (const nested of Object.values(value)) if (nested !== inline) this._emitAudio(nested);
  }

  _play(bytes) {
    if (!this.audioContext || bytes.length < 2) return;
    this._state("speaking");
    this.options.onLevel?.("output", rmsPcm16(bytes));
    const sampleCount = Math.floor(bytes.length / 2);
    const audioBuffer = this.audioContext.createBuffer(1, sampleCount, OUTPUT_RATE);
    const channel = audioBuffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < sampleCount; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);
    const startAt = Math.max(this.audioContext.currentTime + 0.015, this.nextPlaybackTime);
    this.nextPlaybackTime = startAt + audioBuffer.duration;
    this.playbackSources.add(source);
    source.onended = () => {
      this.playbackSources.delete(source);
      if (!this.playbackSources.size && this.ready && !this.muted) {
        this.options.onLevel?.("output", 0);
        this._state("listening");
      }
    };
    source.start(startAt);
  }

  _clearPlayback() {
    for (const source of this.playbackSources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.playbackSources.clear();
    this.nextPlaybackTime = this.audioContext?.currentTime || 0;
    this.options.onLevel?.("output", 0);
  }

  _commitTurn() {
    const user = this.currentUser.trim();
    const assistant = this.currentAssistant.trim();
    if (user || assistant) this.options.onTurn?.({ user, assistant });
    this.currentUser = "";
    this.currentAssistant = "";
    this.options.onPartial?.("user", "");
    this.options.onPartial?.("assistant", "");
  }

  async _cleanupAudio() {
    if (this.processor) this.processor.onaudioprocess = null;
    try { this.processor?.disconnect(); } catch { /* disconnected */ }
    try { this.inputSource?.disconnect(); } catch { /* disconnected */ }
    try { this.silentGain?.disconnect(); } catch { /* disconnected */ }
    for (const track of this.mediaStream?.getTracks() || []) track.stop();
    this.mediaStream = null;
    this.processor = null;
    this.inputSource = null;
    this.silentGain = null;
    if (this.audioContext && this.audioContext.state !== "closed") await this.audioContext.close();
    this.audioContext = null;
  }

  _state(phase, error = "") {
    this.options.onState?.({ phase, error, muted: this.muted });
  }
}
