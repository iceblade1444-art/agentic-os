import { brandMark } from "./brand.js";
import { icon } from "./icons.js";
import { esc, toast } from "./ui.js";
import {
  MILA_ATTACHMENT_ACCEPT, formatAttachmentSize, prepareMilaAttachment,
} from "./mila-attachments.js";
import { milaHub } from "./mila-session.js";

let mounted = false;

function routeName() {
  return (location.hash.replace(/^#\/?/, "").split("/")[0]) || "";
}

function recentMessages(state) {
  return [
    ...state.history.filter((item) => item.role !== "system"),
    ...(state.partials.user ? [{ role: "user", text: state.partials.user, partial: true }] : []),
    ...(state.partials.assistant ? [{ role: "assistant", text: state.partials.assistant, partial: true }] : []),
  ].slice(-4);
}

function messagesHTML(state) {
  const messages = recentMessages(state);
  if (!messages.length) return `<div class="mila-dock-empty">${icon("mic")}<span>Mila is listening. You can keep working.</span></div>`;
  return messages.map((message) => `<div class="mila-dock-message ${message.role}${message.partial ? " partial" : ""}">
    <span>${message.role === "user" ? "You" : "Mila"}</span><p>${esc(message.text)}</p>
  </div>`).join("");
}

function attachmentHTML(item) {
  return `<div class="mila-dock-file" data-attachment-id="${esc(item.id)}">
    ${item.kind === "image" ? `<img src="${esc(item.preview)}" alt=""/>` : icon("file")}
    <span><strong>${esc(item.name)}</strong><small>${formatAttachmentSize(item.size)}</small></span>
    <button type="button" aria-label="Remove attachment">${icon("x")}</button>
  </div>`;
}

export function mountMilaDock() {
  if (mounted || document.querySelector("#milaDock")) return;
  mounted = true;
  let attachments = [];
  let collapsed = false;
  let lastMessagesKey = "";

  const dock = document.createElement("aside");
  dock.className = "mila-dock hidden";
  dock.id = "milaDock";
  dock.setAttribute("aria-label", "Mila Live mini chat");
  dock.innerHTML = `
    <button class="mila-dock-bubble" id="milaDockBubble" type="button" aria-label="Open Mila mini chat">
      ${icon("mic")}<span class="mila-dock-pulse"></span>
    </button>
    <div class="mila-dock-panel">
      <header class="mila-dock-head">
        <span class="mila-dock-avatar">${brandMark()}</span>
        <div><strong>Mila Live</strong><span id="milaDockPhase">Listening</span></div>
        <time class="mono" id="milaDockTimer">00:00</time>
        <a class="icon-btn tip" data-tip="Open full Mila Live" href="#/mila" aria-label="Open full Mila Live">${icon("up")}</a>
        <button class="icon-btn tip" id="milaDockMinimize" data-tip="Minimize" type="button" aria-label="Minimize">${icon("chevdown")}</button>
        <button class="icon-btn danger tip" id="milaDockEnd" data-tip="End call" type="button" aria-label="End call">${icon("x")}</button>
      </header>
      <div class="mila-dock-messages" id="milaDockMessages" aria-live="polite"></div>
      <div class="mila-dock-files" id="milaDockFiles"></div>
      <form class="mila-dock-compose" id="milaDockComposer">
        <button class="icon-btn tip" id="milaDockAttach" data-tip="Attach image or text file" type="button" aria-label="Attach file">${icon("attach")}</button>
        <textarea id="milaDockText" rows="1" maxlength="4000" placeholder="Message Mila…" aria-label="Message Mila"></textarea>
        <button class="icon-btn tip" id="milaDockMute" data-tip="Mute" type="button" aria-label="Mute">${icon("mic")}</button>
        <button class="icon-btn mila-dock-send tip" id="milaDockSend" data-tip="Send" type="submit" aria-label="Send">${icon("send")}</button>
      </form>
      <input class="hidden" id="milaDockFileInput" type="file" accept="${MILA_ATTACHMENT_ACCEPT}" multiple/>
    </div>`;
  document.body.appendChild(dock);

  const bubble = dock.querySelector("#milaDockBubble");
  const panel = dock.querySelector(".mila-dock-panel");
  const messages = dock.querySelector("#milaDockMessages");
  const files = dock.querySelector("#milaDockFiles");
  const text = dock.querySelector("#milaDockText");
  const fileInput = dock.querySelector("#milaDockFileInput");

  const drawFiles = () => {
    files.innerHTML = attachments.map(attachmentHTML).join("");
    files.classList.toggle("active", attachments.length > 0);
    files.querySelectorAll("button").forEach((button) => {
      button.onclick = () => {
        const id = button.closest("[data-attachment-id]").dataset.attachmentId;
        attachments = attachments.filter((item) => item.id !== id);
        drawFiles();
      };
    });
  };

  async function addFiles(selected) {
    const available = Math.max(0, 4 - attachments.length);
    if (!available) return toast("warning", "Attachments", "Up to four files per message");
    for (const file of [...selected].slice(0, available)) {
      try { attachments.push(await prepareMilaAttachment(file)); }
      catch (error) { toast("error", "Attachment rejected", error.message); }
    }
    drawFiles();
  }

  const setCollapsed = (value) => {
    collapsed = value;
    dock.classList.toggle("collapsed", collapsed);
    panel.setAttribute("aria-hidden", String(collapsed));
  };

  const drawState = (state) => {
    dock.classList.toggle("hidden", !state.active || routeName() === "mila");
    dock.dataset.phase = state.phase;
    dock.querySelector("#milaDockPhase").textContent = state.phase === "muted" ? "Microphone muted" : state.phase[0].toUpperCase() + state.phase.slice(1);
    dock.querySelector("#milaDockTimer").textContent = state.elapsedLabel;
    const mute = dock.querySelector("#milaDockMute");
    mute.classList.toggle("active", state.phase === "muted");
    mute.dataset.tip = state.phase === "muted" ? "Unmute" : "Mute";
    mute.setAttribute("aria-label", mute.dataset.tip);
    dock.querySelector("#milaDockSend").disabled = state.sendingTurn;
    const messageKey = recentMessages(state).map((item) => `${item.role}:${item.text}`).join("|");
    if (messageKey !== lastMessagesKey) {
      lastMessagesKey = messageKey;
      messages.innerHTML = messagesHTML(state);
      messages.scrollTop = messages.scrollHeight;
    }
  };

  bubble.onclick = () => setCollapsed(false);
  dock.querySelector("#milaDockMinimize").onclick = () => setCollapsed(true);
  dock.querySelector("#milaDockEnd").onclick = () => milaHub.stop();
  dock.querySelector("#milaDockMute").onclick = () => {
    try {
      const muted = milaHub.toggleMute();
      toast("info", "Mila Live", muted ? "Microphone muted" : "Microphone active");
    } catch (error) { toast("error", "Mila Live", error.message); }
  };
  dock.querySelector("#milaDockAttach").onclick = () => fileInput.click();
  fileInput.onchange = () => { addFiles(fileInput.files); fileInput.value = ""; };
  text.onpaste = (event) => {
    const pastedFiles = [...(event.clipboardData?.files || [])];
    if (pastedFiles.length) { event.preventDefault(); addFiles(pastedFiles); }
  };
  text.oninput = () => { text.style.height = "auto"; text.style.height = `${Math.min(88, text.scrollHeight)}px`; };
  dock.querySelector("#milaDockComposer").onsubmit = async (event) => {
    event.preventDefault();
    const value = text.value.trim();
    if (!value && !attachments.length) return;
    try {
      await milaHub.sendTurn(value, [...attachments]);
      text.value = "";
      text.style.height = "auto";
      attachments = [];
      drawFiles();
    } catch (error) { toast("error", "Mila Live", error.message); }
  };
  window.addEventListener("hashchange", () => drawState(milaHub.snapshot()));
  milaHub.subscribe(drawState);
  drawFiles();
}
