const LIVE_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const LIVEKIT_SDK_URL = "./assets/vendor/livekit-client.umd.js";
const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
const FRAME_INTERVAL_MS = 1050;
const AUDIO_CHUNK_SIZE = 1024;
const MAX_VIDEO_EDGE = 960;
const BROWSER_STT_FALLBACK_MS = 1600;
const THINKING_TIMEOUT_MS = 18000;
const INPUT_ACTIVITY_LEVEL = 0.025;
const SILENCE_BUFFER_MS = 450;

const ACTIVITY_PROFILES = {
  balanced: {
    disabled: false,
    startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
    prefixPaddingMs: 80,
    endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
    silenceDurationMs: 650,
  },
  noisy: {
    disabled: false,
    startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
    prefixPaddingMs: 140,
    endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
    silenceDurationMs: 800,
  },
  deliberate: {
    disabled: false,
    startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
    prefixPaddingMs: 100,
    endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
    silenceDurationMs: 1200,
  },
};

export function buildAutomaticActivityDetection(profile = "balanced") {
  return { ...(ACTIVITY_PROFILES[profile] || ACTIVITY_PROFILES.balanced) };
}

function silenceTurnMs(profile = "balanced") {
  return (ACTIVITY_PROFILES[profile] || ACTIVITY_PROFILES.balanced).silenceDurationMs + SILENCE_BUFFER_MS;
}

// Verified by probing the live API: only the native-audio models accept
// affective dialog. Other live models reject the setup outright.
export function supportsAffectiveDialog(model = "") {
  return /native-audio/i.test(String(model));
}

// Live models answer in audio only — writing goes through MILA's Gemini chat
// endpoint instead (see milaChat), not through this socket.
export function buildLiveSetup(options = {}) {
  const setup = {
    model: `models/${options.model}`,
    generationConfig: { responseModalities: ["AUDIO"] },
    systemInstruction: { parts: [{ text: options.systemInstruction || "" }] },
    contextWindowCompression: { slidingWindow: {} },
    tools: [{ functionDeclarations: options.tools || [] }],
  };

  setup.generationConfig.speechConfig = {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voiceName || "Sulafat" } },
  };
  // Affective dialog lets the model read the caller's tone and answer in kind.
  // Probed against the live API: the field belongs in generationConfig (at the
  // top level every model calls it unknown), and only the native-audio family
  // accepts it — gemini-3.1-flash-live-preview fails the whole setup with an
  // internal error. Sending it only where it works keeps calls connecting on
  // the first attempt; _connect still retries without it as a safety net.
  if (options.affectiveDialog !== false && supportsAffectiveDialog(options.model)) {
    setup.generationConfig.enableAffectiveDialog = true;
  }
  setup.realtimeInputConfig = {
    automaticActivityDetection: buildAutomaticActivityDetection(options.listeningProfile),
    activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
    turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
  };
  setup.inputAudioTranscription = {};
  setup.outputAudioTranscription = {};
  return setup;
}

// A model that does not support affective dialog closes the socket complaining
// about that field; anything else is a real connection failure.
export function isAffectiveDialogRejection(reason = "") {
  const text = String(reason || "");
  if (!/affective|enable_affective_dialog|enableAffectiveDialog/i.test(text)) return false;
  return /unknown|unsupported|not supported|invalid|unexpected/i.test(text) || /affective/i.test(text);
}

// Scripts this workspace never speaks: Devanagari, Bengali, Tamil and friends,
// Arabic, Hebrew, Thai, CJK and Hangul. Gemini's recogniser sometimes renders
// Russian speech as one of these, which then derails the whole answer.
const FOREIGN_SCRIPTS = /[\u0590-\u05ff\u0600-\u06ff\u0900-\u0dff\u0e00-\u0e7f\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u4e00-\u9fff\uac00-\ud7af]/gu;
const CYRILLIC = /[\u0400-\u052f]/gu;

export function isTranscriptPlausible(text, language = "auto") {
  const value = String(text || "");
  if (!value) return true;
  const letters = value.match(/\p{L}/gu) || [];
  if (letters.length < 2) return true;
  // Auto still means Russian, Uzbek or English \u2014 only those scripts are expected,
  // so the guard stays on instead of waving every alphabet through.
  const unexpected = language === "en-US"
    ? [...(value.match(FOREIGN_SCRIPTS) || []), ...(value.match(CYRILLIC) || [])]
    : value.match(FOREIGN_SCRIPTS) || [];
  return unexpected.length / letters.length < 0.35;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let liveKitSdkPromise = null;

function liveKitClientGlobal() {
  return window.LivekitClient || window.LiveKitClient;
}

function loadLiveKitSdk() {
  const existingSdk = liveKitClientGlobal();
  if (existingSdk) return Promise.resolve(existingSdk);
  if (liveKitSdkPromise) return liveKitSdkPromise;
  liveKitSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = LIVEKIT_SDK_URL;
    script.async = true;
    script.onload = () => {
      const sdk = liveKitClientGlobal();
      sdk ? resolve(sdk) : reject(new Error("LiveKit SDK did not initialize"));
    };
    script.onerror = () => reject(new Error("Could not load LiveKit SDK"));
    document.head.appendChild(script);
  });
  return liveKitSdkPromise;
}

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

function mergeTranscript(existing, addition) {
  const left = String(existing || "").trim();
  const right = String(addition || "").trim();
  if (!right) return left;
  if (!left) return right;
  if (left.endsWith(right) || left.includes(right)) return left;
  return `${left} ${right}`.trim();
}

export class MilaLiveSession {
  constructor(options) {
    this.options = options;
    this.socket = null;
    this.livekitRoom = null;
    this.livekitLocalTrack = null;
    this.livekitAudio = new Set();
    this.usingLiveKit = false;
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
    this.speechRecognition = null;
    this.recognitionFinal = "";
    this.recognitionShouldRun = false;
    this.browserTranscription = false;
    this.transcriptWarningSent = false;
    this.browserTextTimer = null;
    this.thinkingTimer = null;
    this.lastTextPrompt = "";
    this.heardSpeech = false;
    this.audioTurnEnded = false;
    this.lastVoiceAt = 0;
    this.videoStream = null;
    this.videoElement = null;
    this.videoCanvas = null;
    this.videoTimer = null;
    this.videoSource = "off";
  }

  async start() {
    this.intentionalClose = false;
    this._state("connecting");
    try {
      await this._openAudio();
      const credentials = await this.options.getToken();
      if (credentials?.participantToken && credentials?.serverUrl) {
        await this._connectLiveKit(credentials);
      } else {
        if (!credentials?.token) throw new Error("Mila did not return a Live token");
        await this._connect(credentials.token);
      }
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
    await this.stopVideo();
    this._clearPlayback();
    this._stopSpeechRecognition();
    clearTimeout(this.thinkingTimer);
    clearTimeout(this.browserTextTimer);
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, "Session ended");
    this.socket = null;
    if (this.livekitRoom) {
      try { await this.livekitRoom.disconnect(); } catch { /* already disconnected */ }
      this.livekitRoom = null;
    }
    for (const element of this.livekitAudio) element.remove();
    this.livekitAudio.clear();
    this.usingLiveKit = false;
    await this._cleanupAudio();
    this._state("idle");
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.usingLiveKit) {
      const action = this.muted
        ? this.livekitLocalTrack?.mute?.()
        : this.livekitLocalTrack?.unmute?.();
      action?.catch?.(() => {});
    } else {
      for (const track of this.mediaStream?.getAudioTracks() || []) track.enabled = !this.muted;
    }
    if (!this.usingLiveKit && this.muted) {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      this._stopSpeechRecognition();
      this.options.onLevel?.("input", 0);
    } else if (!this.usingLiveKit) this._startSpeechRecognition();
    this._state(this.muted ? "muted" : "listening");
    return this.muted;
  }

  sendText(text) {
    return this.sendTurn({ prompt: text, displayText: text });
  }

  // Gemini Live takes video as periodic stills rather than a stream, so the
  // camera or screen is sampled about once a second and pushed as JPEG frames.
  async startVideo(source = "camera") {
    if (this.usingLiveKit) throw new Error("Video needs the direct connection — turn it on in voice preferences and call again");
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot capture video");
    await this.stopVideo();
    const stream = source === "screen"
      ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false })
      : await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false });

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => { /* frames are grabbed even if autoplay is blocked */ });

    this.videoStream = stream;
    this.videoElement = video;
    this.videoCanvas = document.createElement("canvas");
    this.videoSource = source;
    // Stopping a screen share from the browser's own bar must end sharing here too.
    for (const track of stream.getVideoTracks()) track.addEventListener("ended", () => this.stopVideo());
    this.videoTimer = setInterval(() => this._sendVideoFrame(), FRAME_INTERVAL_MS);
    this.options.onVideo?.({ source, stream });
    return source;
  }

  async stopVideo() {
    clearInterval(this.videoTimer);
    this.videoTimer = null;
    for (const track of this.videoStream?.getTracks() || []) track.stop();
    if (this.videoElement) this.videoElement.srcObject = null;
    this.videoStream = null;
    this.videoElement = null;
    this.videoCanvas = null;
    if (this.videoSource !== "off") {
      this.videoSource = "off";
      this.options.onVideo?.({ source: "off", stream: null });
    }
  }

  _sendVideoFrame() {
    const video = this.videoElement;
    const canvas = this.videoCanvas;
    if (!video || !canvas || !this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;
    const scale = Math.min(1, MAX_VIDEO_EDGE / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.6).split(",")[1];
    if (data) this.socket.send(JSON.stringify({ realtimeInput: { video: { data, mimeType: "image/jpeg" } } }));
  }

  async sendTurn({ prompt, displayText, images = [] }) {
    if (this.usingLiveKit) throw new Error("Writing is unavailable during a LiveKit voice call");
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) throw new Error("Mila Live is not connected");
    const message = String(prompt || "").trim();
    if (!message) throw new Error("Add a message or attachment");
    this.currentUser = String(displayText || message).trim();
    this.options.onPartial?.("user", this.currentUser);
    // A live call is already streaming, so images go in as realtime frames
    // ahead of the spoken-style turn.
    for (let index = 0; index < images.length; index++) {
      const item = images[index];
      this.socket.send(JSON.stringify({
        realtimeInput: { video: { data: item.data, mimeType: item.type || "image/jpeg" } },
      }));
      if (index < images.length - 1) await wait(FRAME_INTERVAL_MS);
    }
    this._sendTextTurn(message);
    this._state("thinking");
  }

  _startSpeechRecognition() {
    const language = this.options.transcriptionLanguage || "auto";
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (this.usingLiveKit || !Recognition || language === "auto" || !this.ready || this.muted || this.intentionalClose) {
      this.browserTranscription = false;
      this.options.onTranscriptionMode?.("gemini");
      return;
    }
    this._stopSpeechRecognition();
    const recognition = new Recognition();
    recognition.lang = language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    this.speechRecognition = recognition;
    this.recognitionShouldRun = true;
    this.browserTranscription = true;
    this.options.onTranscriptionMode?.("browser");
    recognition.onresult = (event) => {
      let interim = "";
      let finalChanged = false;
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        const value = result[0]?.transcript?.trim() || "";
        if (!value) continue;
        if (result.isFinal) {
          this.recognitionFinal = `${this.recognitionFinal} ${value}`.trim();
          finalChanged = true;
        }
        else interim = `${interim} ${value}`.trim();
      }
      const value = `${this.recognitionFinal} ${interim}`.trim();
      if (!value) return;
      if (!isTranscriptPlausible(value, language)) {
        if (!this.transcriptWarningSent) this.options.onTranscriptWarning?.();
        this.transcriptWarningSent = true;
        return;
      }
      this.currentUser = value;
      this.options.onPartial?.("user", value);
      if (this.browserTranscription && finalChanged && this.recognitionFinal) this._scheduleBrowserTextFallback(this.recognitionFinal);
    };
    recognition.onerror = (event) => {
      if (["no-speech", "aborted"].includes(event.error)) return;
      this.browserTranscription = false;
      this.recognitionShouldRun = false;
      this.options.onTranscriptionMode?.("gemini");
    };
    recognition.onend = () => {
      if (!this.recognitionShouldRun || !this.ready || this.muted || this.intentionalClose) return;
      setTimeout(() => {
        try { recognition.start(); } catch { this.options.onTranscriptionMode?.("gemini"); }
      }, 180);
    };
    try { recognition.start(); }
    catch {
      this.browserTranscription = false;
      this.recognitionShouldRun = false;
      this.options.onTranscriptionMode?.("gemini");
    }
  }

  _stopSpeechRecognition() {
    this.recognitionShouldRun = false;
    clearTimeout(this.browserTextTimer);
    this.browserTextTimer = null;
    const recognition = this.speechRecognition;
    if (recognition) recognition.onend = null;
    try { recognition?.stop(); } catch { /* already stopped */ }
    this.speechRecognition = null;
    this.browserTranscription = false;
  }

  async _openAudio() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is unavailable in this browser");
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: this._microphoneConstraints() });
    } catch (error) {
      if (this.options.inputDeviceId && ["NotFoundError", "OverconstrainedError"].includes(error?.name)) {
        throw new Error("The selected microphone is unavailable. Choose another microphone in Mila voice preferences.");
      }
      throw error;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio is unavailable in this browser");
    this.audioContext = new AudioContextClass({ latencyHint: "interactive" });
    await this.audioContext.resume();
    this.inputSource = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioContext.createScriptProcessor(AUDIO_CHUNK_SIZE, 1, 1);
    this.silentGain = this.audioContext.createGain();
    this.silentGain.gain.value = 0;
    this.inputSource.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.audioContext.destination);
    this.processor.onaudioprocess = (event) => {
      if (!this.ready || this.muted) return;
      const samples = event.inputBuffer.getChannelData(0);
      const level = rmsFloat(samples);
      this.options.onLevel?.("input", level);
      if (this.usingLiveKit) return;
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      this._trackInputActivity(level);
      const pcm = pcm16FromFloat(samples, this.audioContext.sampleRate);
      this.socket.send(JSON.stringify({
        realtimeInput: { audio: { data: bytesToBase64(pcm), mimeType: `audio/pcm;rate=${INPUT_RATE}` } },
      }));
    };
  }

  _microphoneConstraints() {
    const deviceId = String(this.options.inputDeviceId || "");
    return {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : {}),
    };
  }

  _trackInputActivity(level) {
    if (!this.ready || this.muted || this.currentAssistant) return;
    const nowMs = Date.now();
    if (level >= INPUT_ACTIVITY_LEVEL) {
      this.heardSpeech = true;
      this.audioTurnEnded = false;
      this.lastVoiceAt = nowMs;
      if (this.currentUser) this._state("listening");
      return;
    }
    if (!this.heardSpeech || this.audioTurnEnded || !this.lastVoiceAt) return;
    if (nowMs - this.lastVoiceAt >= silenceTurnMs(this.options.listeningProfile)) {
      this.audioTurnEnded = true;
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        this._state("thinking");
      }
    }
  }

  async _connect(token, setupOverrides = {}) {
    const socket = new WebSocket(`${LIVE_ENDPOINT}?access_token=${encodeURIComponent(token)}`);
    this.socket = socket;
    let rejectedSetupField = false;
    const ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const timeout = setTimeout(() => this.readyReject?.(new Error("Mila Live connection timed out")), 12000);
    socket.onopen = () => {
      socket.send(JSON.stringify({ setup: buildLiveSetup({ ...this.options, ...setupOverrides }) }));
    };
    socket.onmessage = (event) => this._handleFrame(event.data);
    socket.onerror = () => this.readyReject?.(new Error("Gemini Live WebSocket failed"));
    socket.onclose = (event) => {
      this.ready = false;
      rejectedSetupField = isAffectiveDialogRejection(event.reason);
      if (rejectedSetupField) this.readyReject?.(new Error(event.reason || "Setup rejected"));
      else if (!this.intentionalClose) this._state("error", event.reason || "Mila Live disconnected");
    };
    try {
      await ready;
    } catch (error) {
      // Older or non-native-audio models reject enableAffectiveDialog. Retry once
      // plainly so the call still connects instead of surfacing a dead session.
      if (rejectedSetupField && setupOverrides.affectiveDialog !== false) {
        clearTimeout(timeout);
        this.readyResolve = null;
        this.readyReject = null;
        this.affectiveDialogUnavailable = true;
        return this._connect(token, { affectiveDialog: false });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.readyResolve = null;
      this.readyReject = null;
    }
  }

  async _connectLiveKit(credentials) {
    const LK = await loadLiveKitSdk();
    const room = new LK.Room({ adaptiveStream: true, dynacast: true });
    this.livekitRoom = room;
    this.usingLiveKit = true;
    room.on(LK.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== LK.Track.Kind.Audio) return;
      const element = track.attach();
      element.autoplay = true;
      element.playsInline = true;
      element.style.display = "none";
      document.body.appendChild(element);
      this.livekitAudio.add(element);
      this._state("speaking");
    });
    room.on(LK.RoomEvent.TrackUnsubscribed, (track) => {
      for (const element of this.livekitAudio) {
        try { track.detach(element); } catch { /* detached */ }
        element.remove();
        this.livekitAudio.delete(element);
      }
      if (this.ready && !this.muted) this._state("listening");
    });
    room.on(LK.RoomEvent.ActiveSpeakersChanged, (speakers = []) => {
      const remoteSpeaking = speakers.some((participant) => !participant.isLocal);
      if (this.ready && !this.muted) this._state(remoteSpeaking ? "speaking" : "listening");
    });
    room.on(LK.RoomEvent.TranscriptionReceived, (segments = [], participant) => {
      const role = participant?.isLocal === false ? "assistant" : "user";
      for (const segment of segments) {
        const text = String(segment.text || "").trim();
        if (!text) continue;
        if (segment.final === false) this.options.onPartial?.(role, text);
        else {
          if (role === "assistant") {
            this.currentAssistant = mergeTranscript(this.currentAssistant, text);
            this.options.onPartial?.("assistant", this.currentAssistant);
          } else {
            this.currentUser = mergeTranscript(this.currentUser, text);
            this.options.onPartial?.("user", this.currentUser);
          }
          this._commitTurn();
        }
      }
    });
    room.on(LK.RoomEvent.Disconnected, () => {
      this.ready = false;
      if (!this.intentionalClose) this._state("error", "LiveKit voice room disconnected");
    });

    await room.connect(credentials.serverUrl, credentials.participantToken);
    const mediaTrack = this.mediaStream?.getAudioTracks()?.[0];
    if (!mediaTrack || mediaTrack.readyState !== "live") {
      throw new Error("The selected microphone stopped before it could join the LiveKit room");
    }
    const localTrack = new LK.LocalAudioTrack(
      mediaTrack,
      this._microphoneConstraints(),
      true,
      this.audioContext,
    );
    localTrack.source = LK.Track.Source.Microphone;
    this.livekitLocalTrack = localTrack;
    await room.localParticipant.publishTrack(localTrack, {
      name: "mila-microphone",
      source: LK.Track.Source.Microphone,
      dtx: true,
      red: true,
    });
    this.ready = true;
    this._state("listening");
    this._stopSpeechRecognition();
    this.options.onTranscriptionMode?.("gemini");
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
      this._startSpeechRecognition();
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
        if (isTranscriptPlausible(userText, this.options.transcriptionLanguage)) {
          this.currentUser = mergeTranscript(this.currentUser, userText);
          this.options.onPartial?.("user", this.currentUser);
          if (!this.currentAssistant) this._state("thinking");
        } else if (!this.transcriptWarningSent) {
          this.transcriptWarningSent = true;
          this.options.onTranscriptWarning?.();
        }
      }
      // Voice turns stream through outputTranscription; text turns arrive as
      // plain parts on the model turn.
      const assistantText = content.outputTranscription?.text;
      if (assistantText) {
        clearTimeout(this.thinkingTimer);
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
    clearTimeout(this.thinkingTimer);
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
    this.recognitionFinal = "";
    this.transcriptWarningSent = false;
    this.lastTextPrompt = "";
    this.heardSpeech = false;
    this.audioTurnEnded = false;
    this.lastVoiceAt = 0;
    this.options.onPartial?.("user", "");
    this.options.onPartial?.("assistant", "");
  }

  _sendTextTurn(text) {
    const value = String(text || "").trim();
    if (!value || this.lastTextPrompt === value || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.lastTextPrompt = value;
    this.socket.send(JSON.stringify({
      clientContent: { turns: [{ role: "user", parts: [{ text: value }] }], turnComplete: true },
    }));
    return true;
  }

  _scheduleBrowserTextFallback(text) {
    clearTimeout(this.browserTextTimer);
    this.browserTextTimer = setTimeout(() => {
      const value = String(text || this.recognitionFinal || this.currentUser || "").trim();
      if (!value || this.currentAssistant) return;
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        this.audioTurnEnded = true;
        this._sendTextTurn(value);
        this._state("thinking");
      }
    }, BROWSER_STT_FALLBACK_MS);
  }

  async _cleanupAudio() {
    this._stopSpeechRecognition();
    clearTimeout(this.thinkingTimer);
    clearTimeout(this.browserTextTimer);
    if (this.processor) this.processor.onaudioprocess = null;
    try { this.processor?.disconnect(); } catch { /* disconnected */ }
    try { this.inputSource?.disconnect(); } catch { /* disconnected */ }
    try { this.silentGain?.disconnect(); } catch { /* disconnected */ }
    this.livekitLocalTrack = null;
    for (const track of this.mediaStream?.getTracks() || []) track.stop();
    this.mediaStream = null;
    this.processor = null;
    this.inputSource = null;
    this.silentGain = null;
    if (this.audioContext && this.audioContext.state !== "closed") await this.audioContext.close();
    this.audioContext = null;
  }

  _state(phase, error = "") {
    clearTimeout(this.thinkingTimer);
    if (phase === "thinking" && !error) {
      this.thinkingTimer = setTimeout(() => {
        if (this.intentionalClose || this.currentAssistant) return;
        this._commitTurn();
        this._state(this.ready && !this.muted ? "listening" : "idle");
      }, THINKING_TIMEOUT_MS);
    }
    this.options.onState?.({ phase, error, muted: this.muted });
  }
}
