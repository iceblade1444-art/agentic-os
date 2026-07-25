import { icon } from "../icons.js";
import { closeOverlay, esc, openModal, toast } from "../ui.js";
import {
  MILA_ATTACHMENT_ACCEPT, formatAttachmentSize, prepareMilaAttachment,
} from "../mila-attachments.js";
import { listMilaMicrophones, testMilaMicrophone } from "../mila-audio-devices.js";
import { supportsAffectiveDialog } from "../mila-live.js";
import {
  MILA_DELIVERIES, MILA_LANGUAGES, MILA_LISTENING_PROFILES, MILA_PACES, MILA_PERSONA_LIMIT,
  MILA_RESPONSE_LENGTHS, MILA_STYLES, MILA_VOICES, MILA_VOICE_DIRECTION_LIMIT, MILA_VOICE_GROUPS, milaHub,
} from "../mila-session.js";

let pendingAttachments = [];
let unsubscribe = null;

const PHASES = {
  checking: ["Checking", "neutral"], idle: ["Ready", "success"], connecting: ["Connecting", "warning"],
  listening: ["Listening", "success"], thinking: ["Thinking", "warning"], speaking: ["Speaking", "info"],
  muted: ["Muted", "neutral"], error: ["Unavailable", "error"],
};

function attachmentHTML(attachment, removable = false) {
  const visual = attachment.kind === "image"
    ? `<button class="mila-attachment-preview" type="button" data-preview-image data-name="${esc(attachment.name)}"><img src="${esc(attachment.preview)}" alt=""/></button>`
    : `<span class="mila-attachment-file">${icon("file")}</span>`;
  return `<div class="mila-attachment" data-attachment-id="${esc(attachment.id)}">
    ${visual}<span class="mila-attachment-copy"><strong>${esc(attachment.name)}</strong><small>${formatAttachmentSize(attachment.size)}</small></span>
    ${removable ? `<button class="icon-btn mila-remove-attachment tip" type="button" data-tip="Remove" aria-label="Remove attachment">${icon("x")}</button>` : ""}
  </div>`;
}

function messagesFor(state) {
  return [
    ...state.history,
    ...(state.partials.user ? [{ role: "user", text: state.partials.user, partial: true, attachments: state.pendingTurnAttachments }] : []),
    ...(state.partials.assistant ? [{ role: "assistant", text: state.partials.assistant, partial: true }] : []),
  ];
}

function transcriptHTML(state) {
  const messages = messagesFor(state);
  if (!messages.length) return `<div class="mila-empty"><span>${icon("mic")}</span><strong>No conversation yet</strong><small>Voice, text and attachments</small></div>`;
  return messages.map((message) => message.role === "system"
    ? `<div class="mila-event">${icon("brain")}<span>${esc(message.text)}</span><time>${esc(message.at || "")}</time></div>`
    : `<div class="mila-line ${message.role}${message.partial ? " partial" : ""}">
        <div class="mila-line-meta"><span class="mila-speaker">${message.role === "user" ? "You" : "Mila"}</span><time>${esc(message.at || "")}</time></div>
        <p>${esc(message.text)}</p>
        ${message.attachments?.length ? `<div class="mila-history-attachments">${message.attachments.map((item) => attachmentHTML(item)).join("")}</div>` : ""}
      </div>`).join("");
}

function barsHTML() {
  return Array.from({ length: 31 }, (_, index) => `<i style="--bar:${index}"></i>`).join("");
}

function languageOptions() {
  return MILA_LANGUAGES.map(([code, label]) => `<option value="${code}"${code === milaHub.state.language ? " selected" : ""}>${label}</option>`).join("");
}

function optionsHTML(items, selected) {
  return items.map((item) => `<option value="${esc(item.id)}"${item.id === selected ? " selected" : ""}>${esc(item.label)}${item.description ? ` · ${esc(item.description)}` : ""}</option>`).join("");
}

// 30 voices are too many for a flat list, so they are grouped by character.
function voiceOptionsHTML(selected) {
  return MILA_VOICE_GROUPS.map((group) => {
    const voices = MILA_VOICES.filter((voice) => voice.group === group.id);
    if (!voices.length) return "";
    return `<optgroup label="${esc(group.label)}">${voices.map((voice) =>
      `<option value="${esc(voice.id)}"${voice.id === selected ? " selected" : ""}>${esc(voice.label)} · ${esc(voice.description)} (${esc(voice.id)})</option>`).join("")}</optgroup>`;
  }).join("");
}

function segmentsHTML(name, items, selected) {
  return items.map((item) => `<label><input type="radio" name="${esc(name)}" value="${esc(item.id)}"${item.id === selected ? " checked" : ""}/><span>${esc(item.label)}</span></label>`).join("");
}

function transcriptMarkdown(state) {
  return state.history.map((message) => {
    if (message.role === "system") return `> ${message.text}`;
    const files = message.attachments?.length ? `\n\nAttachments: ${message.attachments.map((item) => item.name).join(", ")}` : "";
    return `**${message.role === "user" ? "You" : "Mila"}** ${message.at || ""}\n\n${message.text}${files}`;
  }).join("\n\n---\n\n");
}

export default {
  title: "Mila Live",
  render() {
    return `<div class="mila-live">
      <div class="page-head mila-head">
        <div><div class="page-title">Mila Live</div><div class="page-sub">Gemini Live voice · Hermes · Kanban · Obsidian · Claude</div></div>
        <div class="spacer"></div>
        <label class="mila-language-wrap tip" data-tip="Speech recognition language"><span>${icon("chat")}</span><select id="milaLanguage" aria-label="Speech recognition language">${languageOptions()}</select></label>
        <span class="badge neutral" id="milaStatus"><span class="dot"></span>Checking</span>
        <span class="badge neutral mono" id="milaTimer">00:00</span>
        <button class="icon-btn tip" id="milaPreferences" data-tip="Voice preferences" aria-label="Voice preferences">${icon("sparkles")}</button>
        <a class="icon-btn tip" data-tip="Mila integration" href="#/integrations">${icon("settings")}</a>
      </div>

      <div class="mila-grid">
        <section class="mila-stage" id="milaStage" aria-label="Mila live voice">
          <div class="mila-drop-overlay" id="milaDropOverlay">${icon("upload")}<strong>Drop files for Mila</strong></div>
          <div class="mila-identity">
            <span class="mila-mark">${icon("mic")}</span>
            <div class="stack"><strong>Mila</strong><span class="muted text-sm" id="milaModel">Voice backend</span></div>
            <span class="badge neutral mila-profile" id="milaProfile">Warm · Assistant</span>
            <span class="badge neutral mila-stt" id="milaSttMode">Direct audio</span>
            <a class="mila-handoff" href="#/hermes">${icon("brain")}Hermes</a>
          </div>

          <div class="mila-voice-core">
            <div class="mila-wave" id="milaWave" aria-hidden="true">${barsHTML()}</div>
            <div class="mila-phase" id="milaPhase">Ready</div>
            <div class="mila-caption" id="milaCaption" aria-live="polite"></div>
            <div class="mila-controls">
              <button class="mila-mic tip" id="milaMic" data-tip="Start live call" aria-label="Start live call">${icon("mic")}</button>
              <button class="icon-btn mila-video-btn tip hidden" id="milaCamera" data-tip="Show your camera to Mila" aria-label="Share camera" type="button">${icon("video")}</button>
              <button class="icon-btn mila-video-btn tip hidden" id="milaScreen" data-tip="Show your screen to Mila" aria-label="Share screen" type="button">${icon("monitor")}</button>
              <button class="mila-end tip hidden" id="milaEnd" data-tip="End call" aria-label="End call">${icon("x")}</button>
            </div>
            <div class="mila-selfview hidden" id="milaSelfView">
              <video id="milaSelfVideo" muted playsinline autoplay></video>
              <span class="mila-selfview-label" id="milaSelfLabel">Camera</span>
              <button class="icon-btn tip" id="milaVideoStop" data-tip="Stop sharing" aria-label="Stop sharing" type="button">${icon("x")}</button>
            </div>
            <div class="mila-meters">
              <span>${icon("mic")}<i><b id="milaInputLevel"></b></i></span>
              <span>${icon("activity")}<i><b id="milaOutputLevel"></b></i></span>
            </div>
          </div>

          <div class="mila-quick-actions">
            <button class="btn btn-ghost sm" id="milaSystemPrompt" type="button">${icon("activity")}System status</button>
            <a class="btn btn-ghost sm" href="#/workflows">${icon("branch")}Kanban</a>
            <a class="btn btn-ghost sm" href="#/knowledge">${icon("book")}Obsidian</a>
            <a class="btn btn-ghost sm" href="#/claude-code">${icon("code")}Claude</a>
            <a class="btn btn-ghost sm" href="#/hermes">${icon("brain")}Hermes</a>
          </div>

          <div class="mila-compose-zone">
            <div class="mila-attachments" id="milaAttachments"></div>
            <form class="mila-composer" id="milaComposer">
              <button class="icon-btn tip" id="milaAttach" data-tip="Attach image or text file" aria-label="Attach file" type="button">${icon("attach")}</button>
              <textarea id="milaText" rows="1" maxlength="4000" placeholder="Message Mila…" autocomplete="off"></textarea>
              <button class="icon-btn mila-send tip" id="milaSend" data-tip="Send" aria-label="Send" type="submit">${icon("send")}</button>
            </form>
            <input class="hidden" id="milaFile" type="file" accept="${MILA_ATTACHMENT_ACCEPT}" multiple/>
          </div>
        </section>

        <section class="mila-transcript" aria-label="Live transcript">
          <div class="mila-transcript-head">
            <div><strong>Transcript</strong><span id="milaTranscriptMeta">Live session</span></div>
            <div class="mila-transcript-actions">
              <button class="icon-btn tip" id="milaCopy" data-tip="Copy transcript" aria-label="Copy transcript">${icon("copy")}</button>
              <button class="icon-btn tip" id="milaExport" data-tip="Export Markdown" aria-label="Export transcript">${icon("save")}</button>
              <button class="icon-btn tip" id="milaClear" data-tip="Clear transcript" aria-label="Clear transcript">${icon("trash")}</button>
            </div>
          </div>
          <div class="mila-scroll" id="milaScroll" aria-live="polite"></div>
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
    const send = root.querySelector("#milaSend");
    const language = root.querySelector("#milaLanguage");
    const errorBox = root.querySelector("#milaError");
    const attachmentHost = root.querySelector("#milaAttachments");
    const fileInput = root.querySelector("#milaFile");
    const stage = root.querySelector("#milaStage");
    const preferencesButton = root.querySelector("#milaPreferences");
    const cameraButton = root.querySelector("#milaCamera");
    const screenButton = root.querySelector("#milaScreen");
    const selfView = root.querySelector("#milaSelfView");
    const selfVideo = root.querySelector("#milaSelfVideo");
    const selfLabel = root.querySelector("#milaSelfLabel");
    let lastTranscriptKey = "";
    let lastWarning = milaHub.state.transcriptWarning;

    const openPreview = (src, name) => openModal({
      title: name || "Image", width: 900,
      body: `<div class="mila-image-modal"><img src="${esc(src)}" alt="${esc(name || "Attached image")}"/></div>`,
    });
    const openPreferences = () => {
      if (milaHub.active) return toast("info", "Voice preferences", "End the current call before changing its voice profile");
      const prefs = milaHub.state.preferences;
      openModal({
        title: "Mila voice preferences",
        width: 620,
        body: `<div class="mila-settings">
          <div class="mila-settings-grid">
            <div class="field"><label class="label" for="milaVoiceName">Voice</label><select class="select" id="milaVoiceName">${voiceOptionsHTML(prefs.voiceName)}</select><span class="hint">All ${MILA_VOICES.length} Gemini Live voices</span></div>
            <div class="field"><label class="label" for="milaListeningProfile">Listening</label><select class="select" id="milaListeningProfile">${optionsHTML(MILA_LISTENING_PROFILES, prefs.listeningProfile)}</select></div>
          </div>
          <div class="field"><label class="label" for="milaInputDevice">Microphone</label><select class="select" id="milaInputDevice" disabled><option value="">Loading microphones…</option></select></div>
          <div class="mila-mic-check">
            <button class="btn btn-secondary" id="milaTestMicrophone" type="button" disabled>${icon("mic")}Test microphone</button>
            <div class="mila-mic-check-meter" aria-hidden="true"><span id="milaMicCheckLevel"></span></div>
            <span class="mila-mic-check-result" id="milaMicCheckResult">Choose the Windows input you speak into.</span>
          </div>
          <fieldset class="mila-setting-group"><legend>Conversation style</legend><div class="mila-segments four">${segmentsHTML("milaStyle", MILA_STYLES, prefs.style)}</div></fieldset>
          <div class="mila-settings-grid">
            <fieldset class="mila-setting-group"><legend>Speaking pace</legend><div class="mila-segments">${segmentsHTML("milaPace", MILA_PACES, prefs.pace)}</div></fieldset>
            <fieldset class="mila-setting-group"><legend>Voice answers</legend><div class="mila-segments two">${segmentsHTML("milaResponseLength", MILA_RESPONSE_LENGTHS, prefs.responseLength)}</div></fieldset>
          </div>
          <fieldset class="mila-setting-group"><legend>Delivery</legend><div class="mila-segments five">${segmentsHTML("milaDelivery", MILA_DELIVERIES, prefs.delivery)}</div></fieldset>
          <div class="field"><label class="label" for="milaPersona">Who Mila is <span class="muted">(optional)</span></label>
            <textarea class="input mila-persona" id="milaPersona" rows="4" maxlength="${MILA_PERSONA_LIMIT}" placeholder="Опишите её характер: кто она, как держится, что для неё важно, чего избегает.&#10;Например: Тебя зовут Мила. Ты спокойная и внимательная, говоришь просто и по делу, без канцелярита. Ты не льстишь и не извиняешься попусту. Если чего-то не знаешь — говоришь прямо.">${esc(prefs.persona)}</textarea>
            <span class="hint">Her character in your own words — it takes precedence over the built-in manner, in both voice and writing. Safety rules and confirmations stay in force.</span>
          </div>
          <div class="field"><label class="label" for="milaVoiceDirection">Voice direction <span class="muted">(optional)</span></label>
            <input class="input" id="milaVoiceDirection" maxlength="${MILA_VOICE_DIRECTION_LIMIT}" value="${esc(prefs.voiceDirection)}" placeholder="e.g. Speak like a calm night-radio host, never hurry"/>
            <span class="hint">Your own note on how Mila should sound. She also follows spoken cues — “whisper”, “speak faster” — and bracketed cues like [excited] without reading them aloud.</span>
          </div>
          <label class="mila-toggle-row"><input type="checkbox" id="milaAffectiveDialog"${prefs.affectiveDialog ? " checked" : ""}/>
            <span><strong>Affective dialog</strong><small>Mila hears your tone and answers in kind. ${supportsAffectiveDialog(milaHub.state.model)
              ? `Active on ${esc(milaHub.state.model)}.`
              : `Not available on ${esc(milaHub.state.model)} — it needs a native-audio model, set by GEMINI_LIVE_MODEL on the MILA backend.`}</small></span>
          </label>
          <label class="mila-toggle-row"><input type="checkbox" id="milaProactiveAudio"${prefs.proactiveAudio ? " checked" : ""}/>
            <span><strong>Proactive audio</strong><small>Mila stays quiet when speech was not aimed at her — useful in a room with other people. Turn off if she skips something you meant for her.</small></span>
          </label>
          <label class="mila-toggle-row"><input type="checkbox" id="milaDirectConnection"${prefs.directConnection ? " checked" : ""}/>
            <span><strong>Direct connection — enables camera and screen</strong><small>Calls go straight to Gemini instead of through the LiveKit room, which cannot carry video. Turn off for LiveKit's echo handling on noisy setups.</small></span>
          </label>
          <div class="field mila-name-field"><label class="label" for="milaUserName">Your name</label><input class="input" id="milaUserName" maxlength="40" value="${esc(prefs.userName)}" autocomplete="name"/></div>
          <div class="mila-settings-note">Changes apply when the next live call starts.</div>
        </div>`,
        footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="milaSavePreferences">${icon("check")}Save</button>`,
        onMount: (modal) => {
          const microphone = modal.querySelector("#milaInputDevice");
          const testButton = modal.querySelector("#milaTestMicrophone");
          const testLevel = modal.querySelector("#milaMicCheckLevel");
          const testResult = modal.querySelector("#milaMicCheckResult");
          listMilaMicrophones().then((devices) => {
            microphone.innerHTML = [
              `<option value="">System default</option>`,
              ...devices.filter((device) => device.id !== "default")
                .map((device) => `<option value="${esc(device.id)}">${esc(device.label)}</option>`),
            ].join("");
            microphone.value = devices.some((device) => device.id === prefs.inputDeviceId) ? prefs.inputDeviceId : "";
            microphone.disabled = false;
            testButton.disabled = false;
          }).catch((error) => {
            microphone.innerHTML = `<option value="">Microphones unavailable</option>`;
            testResult.textContent = error.message || "Allow microphone access in the browser";
          });
          testButton.onclick = async () => {
            testButton.disabled = true;
            testResult.textContent = "Speak normally for a few seconds…";
            try {
              const maximum = await testMilaMicrophone(microphone.value, (level) => {
                testLevel.style.width = `${Math.round(level * 100)}%`;
              });
              testResult.textContent = maximum >= 0.08
                ? "Good signal. This microphone can hear you."
                : maximum >= 0.025
                  ? "Signal is quiet. Move closer or choose another microphone."
                  : "No voice detected. Choose another microphone.";
            } catch (error) {
              testResult.textContent = error.message || "Microphone test failed";
            } finally {
              testButton.disabled = false;
            }
          };
          modal.querySelector("#milaSavePreferences").onclick = () => {
            const selected = (name) => modal.querySelector(`input[name="${name}"]:checked`)?.value;
            const saved = milaHub.setPreferences({
              voiceName: modal.querySelector("#milaVoiceName").value,
              listeningProfile: modal.querySelector("#milaListeningProfile").value,
              style: selected("milaStyle"),
              pace: selected("milaPace"),
              delivery: selected("milaDelivery"),
              persona: modal.querySelector("#milaPersona").value,
              voiceDirection: modal.querySelector("#milaVoiceDirection").value,
              affectiveDialog: modal.querySelector("#milaAffectiveDialog").checked,
              proactiveAudio: modal.querySelector("#milaProactiveAudio").checked,
              directConnection: modal.querySelector("#milaDirectConnection").checked,
              responseLength: selected("milaResponseLength"),
              userName: modal.querySelector("#milaUserName").value,
              inputDeviceId: microphone.value,
            });
            if (!saved) return toast("warning", "Voice preferences", "End the current call before saving changes");
            closeOverlay();
            toast("success", "Mila updated", "The new voice profile is ready for the next call");
          };
        },
      });
    };
    const wirePreviews = (host) => host.querySelectorAll("[data-preview-image]").forEach((button) => {
      button.onclick = () => openPreview(button.querySelector("img").src, button.dataset.name);
    });
    const drawAttachments = () => {
      attachmentHost.innerHTML = pendingAttachments.map((item) => attachmentHTML(item, true)).join("");
      attachmentHost.classList.toggle("active", pendingAttachments.length > 0);
      attachmentHost.querySelectorAll(".mila-remove-attachment").forEach((button) => {
        button.onclick = () => {
          const id = button.closest("[data-attachment-id]").dataset.attachmentId;
          pendingAttachments = pendingAttachments.filter((item) => item.id !== id);
          drawAttachments();
        };
      });
      wirePreviews(attachmentHost);
    };
    const drawLevels = (state) => {
      root.querySelector("#milaInputLevel").style.width = `${Math.round(state.inputLevel * 100)}%`;
      root.querySelector("#milaOutputLevel").style.width = `${Math.round(state.outputLevel * 100)}%`;
      const amount = Math.max(state.inputLevel, state.outputLevel);
      root.querySelectorAll("#milaWave i").forEach((bar, index, bars) => {
        const distance = Math.abs(index - (bars.length - 1) / 2) / (bars.length / 2);
        const shape = Math.max(0.12, 1 - distance * 0.72);
        const motion = 0.55 + Math.abs(Math.sin(index * 1.7 + Date.now() / 180)) * 0.45;
        bar.style.height = `${Math.max(5, Math.round(8 + amount * 72 * shape * motion))}px`;
      });
    };
    const drawState = (state) => {
      const [label, cls] = PHASES[state.phase] || PHASES.idle;
      phase.textContent = label;
      status.className = `badge ${cls}`;
      status.innerHTML = `<span class="dot"></span>${label}`;
      stage.dataset.phase = state.phase;
      root.querySelector("#milaTimer").textContent = state.elapsedLabel;
      root.querySelector("#milaModel").textContent = state.model;
      const voice = MILA_VOICES.find((item) => item.id === state.preferences.voiceName)?.label || state.preferences.voiceName;
      const style = MILA_STYLES.find((item) => item.id === state.preferences.style)?.label || state.preferences.style;
      const delivery = MILA_DELIVERIES.find((item) => item.id === state.preferences.delivery)?.label || "";
      root.querySelector("#milaProfile").textContent = [voice, style, delivery].filter(Boolean).join(" · ");
      const stt = root.querySelector("#milaSttMode");
      stt.textContent = state.transcriptionMode === "browser" ? "Browser STT" : "Direct audio";
      stt.className = `badge mila-stt ${state.transcriptionMode === "browser" ? "success" : "neutral"}`;
      caption.textContent = state.partials.assistant || state.partials.user || "";
      end.classList.toggle("hidden", !state.active);
      language.disabled = state.active;
      preferencesButton.disabled = state.active;
      language.value = state.language;
      mic.dataset.tip = state.active ? (state.phase === "muted" ? "Unmute" : "Mute") : "Start live call";
      mic.setAttribute("aria-label", mic.dataset.tip);
      mic.classList.toggle("muted", state.phase === "muted");
      send.disabled = state.sendingTurn;
      errorBox.classList.toggle("hidden", !state.error);
      root.querySelector("#milaErrorText").textContent = state.error;
      drawLevels(state);

      // Video only rides the call; writing works with or without one.
      cameraButton.classList.toggle("hidden", !state.active);
      screenButton.classList.toggle("hidden", !state.active);
      cameraButton.classList.toggle("active", state.videoSource === "camera");
      screenButton.classList.toggle("active", state.videoSource === "screen");
      const sharing = state.videoSource !== "off";
      selfView.classList.toggle("hidden", !sharing);
      if (sharing) {
        selfLabel.textContent = state.videoSource === "screen" ? "Screen" : "Camera";
        const stream = milaHub.session?.videoStream || null;
        if (stream && selfVideo.srcObject !== stream) selfVideo.srcObject = stream;
      } else if (selfVideo.srcObject) selfVideo.srcObject = null;

      // On a call Mila speaks whatever you type; without one she writes back.
      const thinkingInText = !state.active && (state.sendingTurn || state.textPhase === "thinking");
      text.placeholder = thinkingInText
        ? "Mila is writing…"
        : state.active ? "Type — Mila answers out loud…" : "Write to Mila — no call needed…";
      if (!state.active && state.textPhase === "error" && state.textError) {
        errorBox.classList.remove("hidden");
        root.querySelector("#milaErrorText").textContent = state.textError;
      }

      const transcriptKey = `${state.history.length}|${state.history.at(-1)?.text || ""}|${state.partials.user}|${state.partials.assistant}|${state.pendingTurnAttachments.map((item) => item.id).join(",")}`;
      if (transcriptKey !== lastTranscriptKey) {
        lastTranscriptKey = transcriptKey;
        scroll.innerHTML = transcriptHTML(state);
        scroll.scrollTop = scroll.scrollHeight;
        root.querySelector("#milaTranscriptMeta").textContent = state.history.length ? `${state.history.length} entries` : "Live session";
        wirePreviews(scroll);
      }
      if (state.transcriptWarning > lastWarning) {
        lastWarning = state.transcriptWarning;
        toast("warning", "Transcription corrected", "Unreliable foreign-script text was hidden. Check the selected language.");
      }
    };

    async function addFiles(files) {
      const available = Math.max(0, 4 - pendingAttachments.length);
      if (!available) return toast("warning", "Attachments", "Up to four files per message");
      for (const file of [...files].slice(0, available)) {
        try { pendingAttachments.push(await prepareMilaAttachment(file)); }
        catch (error) { toast("error", "Attachment rejected", error.message); }
      }
      drawAttachments();
    }

    async function submitMessage() {
      const value = text.value.trim();
      if (!value && !pendingAttachments.length) return;
      try {
        await milaHub.sendTurn(value, [...pendingAttachments]);
        text.value = "";
        text.style.height = "auto";
        pendingAttachments = [];
        drawAttachments();
      } catch (error) { toast("error", "Mila Live", error.message); }
    }

    mic.onclick = async () => {
      try {
        if (!milaHub.active) await milaHub.start();
        else {
          const muted = milaHub.toggleMute();
          toast("info", "Mila Live", muted ? "Microphone muted" : "Microphone active");
        }
      } catch (error) { toast("error", "Mila Live", error.message); }
    };

    const shareVideo = async (source) => {
      try {
        const next = milaHub.state.videoSource === source ? "off" : source;
        await milaHub.setVideo(next);
        if (next !== "off") {
          toast("success", "Mila can see", source === "screen" ? "Your screen is shared" : "Your camera is shared");
        }
      } catch (error) {
        // The browser's own "cancel" on the picker is a choice, not a failure.
        if (error.name === "NotAllowedError" || error.name === "AbortError") return;
        toast("error", "Video", error.message);
      }
    };
    cameraButton.onclick = () => shareVideo("camera");
    screenButton.onclick = () => shareVideo("screen");
    root.querySelector("#milaVideoStop").onclick = () => shareVideo(milaHub.state.videoSource);
    end.onclick = () => milaHub.stop();
    language.onchange = () => milaHub.setLanguage(language.value);
    preferencesButton.onclick = openPreferences;
    root.querySelector("#milaComposer").onsubmit = (event) => { event.preventDefault(); submitMessage(); };
    root.querySelector("#milaAttach").onclick = () => fileInput.click();
    fileInput.onchange = () => { addFiles(fileInput.files); fileInput.value = ""; };
    text.onpaste = (event) => {
      const files = [...(event.clipboardData?.files || [])];
      if (files.length) { event.preventDefault(); addFiles(files); }
    };
    text.oninput = () => { text.style.height = "auto"; text.style.height = `${Math.min(120, text.scrollHeight)}px`; };
    root.querySelector("#milaSystemPrompt").onclick = () => {
      const prompts = { "ru-RU": "Проверь состояние Agentic OS и кратко расскажи, что сейчас работает.", "uz-UZ": "Agentic OS holatini tekshir va nimalar ishlayotganini qisqacha ayt.", "en-US": "Check Agentic OS status and briefly tell me what is working." };
      text.value = prompts[milaHub.state.language] || prompts["en-US"];
      text.focus();
    };
    root.querySelector("#milaClear").onclick = () => milaHub.clearHistory();
    root.querySelector("#milaCopy").onclick = async () => {
      if (!milaHub.state.history.length) return toast("info", "Transcript", "Nothing to copy yet");
      try { await navigator.clipboard.writeText(transcriptMarkdown(milaHub.state)); toast("success", "Transcript copied"); }
      catch { toast("error", "Transcript", "Clipboard access was denied"); }
    };
    root.querySelector("#milaExport").onclick = () => {
      if (!milaHub.state.history.length) return toast("info", "Transcript", "Nothing to export yet");
      const url = URL.createObjectURL(new Blob([transcriptMarkdown(milaHub.state)], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `mila-session-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    stage.ondragover = (event) => { event.preventDefault(); stage.classList.add("dragging"); };
    stage.ondragleave = (event) => { if (!stage.contains(event.relatedTarget)) stage.classList.remove("dragging"); };
    stage.ondrop = (event) => {
      event.preventDefault();
      stage.classList.remove("dragging");
      addFiles(event.dataTransfer?.files || []);
    };

    unsubscribe = milaHub.subscribe(drawState);
    drawAttachments();
    milaHub.loadStatus().catch(() => {});
  },

  unmount() {
    unsubscribe?.();
    unsubscribe = null;
    pendingAttachments = [];
  },
};
