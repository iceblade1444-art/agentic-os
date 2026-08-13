// The corporate chat: channels for the team, direct threads with colleagues.
//
// This route used to hold a second assistant conversation, which duplicated
// Mila Live. Mila is still here — but as one participant among people, answering
// when addressed rather than being the only one you can talk to.

import { api } from "../api.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { esc, initials, toast } from "../ui.js";

let state = null;
let error = "";
let activeId = "";
let messages = [];
let readBy = {};
let hasMore = false;
let loadingThread = false;
let loadingOlder = false;
let sending = false;
let stream = null;
let search = "";
let searchResults = null;
let searchTimer = null;
let replyTo = null;
let editing = null;
let pending = [];
let typingNames = new Map();
let typingTimer = null;
let lastTypingSent = 0;
let recorder = null;
let recordingSince = 0;
let reactingTo = "";
let showMembers = false;

let mountRoot = null;
let markReadAt = 0;

// Re-render this page in place. Dispatching a hashchange would make the router
// tear the page down and call mount() again — which reloads the conversation,
// which re-renders, which mounts again: an unbounded request loop that ran the
// API into its rate limit. Rendering in place also keeps what you were typing
// and where you were scrolled, which a remount threw away on every keystroke.
function rerender() {
  const root = mountRoot;
  if (!root || !root.isConnected) return;
  const thread = root.querySelector("#chatThread");
  const stickToBottom = !thread || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
  const previousScroll = thread?.scrollTop ?? 0;
  const input = root.querySelector("[data-input]");
  const draft = input ? input.value : null;
  const caret = input ? input.selectionStart : null;
  const focused = document.activeElement;
  const refocus = focused?.dataset?.input !== undefined ? "input"
    : focused?.dataset?.search !== undefined ? "search" : "";

  root.innerHTML = render();
  wire(root);

  const nextInput = root.querySelector("[data-input]");
  if (nextInput && draft !== null) {
    nextInput.value = draft;
    if (caret !== null) nextInput.setSelectionRange(caret, caret);
  }
  if (refocus === "input") nextInput?.focus();
  if (refocus === "search") {
    const nextSearch = root.querySelector("[data-search]");
    nextSearch?.focus();
    nextSearch?.setSelectionRange(nextSearch.value.length, nextSearch.value.length);
  }
  const nextThread = root.querySelector("#chatThread");
  if (nextThread) nextThread.scrollTop = stickToBottom ? nextThread.scrollHeight : previousScroll;
}
const byId = (id) => state?.people.find((person) => person.id === id) || null;
const isAgent = (id) => String(id || "").startsWith("agent:");
const active = () => state?.conversations.find((conversation) => conversation.id === activeId) || null;
const canModerate = () => ["Creator", "Admin"].includes(state?.me.role);

function clockOf(value) {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
  } catch {
    return String(value || "").slice(11, 16);
  }
}

function dayOf(value) {
  try {
    return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long" }).format(new Date(value));
  } catch {
    return String(value || "").slice(0, 10);
  }
}

const sizeOf = (bytes) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const durationOf = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

function conversationTitle(conversation) {
  if (conversation.kind === "channel") return conversation.name;
  return conversation.name || t("chat.direct");
}

function avatar(conversation) {
  if (conversation.kind === "channel") return `<span class="chat-avatar channel">${icon("chat")}</span>`;
  if (isAgent(conversation.otherId)) return `<span class="chat-avatar agent">${icon("sparkles")}</span>`;
  const person = byId(conversation.otherId);
  return `<span class="chat-avatar${person?.online ? " online" : ""}">${esc(initials(conversationTitle(conversation)))}</span>`;
}

function previewOf(message, conversation) {
  if (!message) return t("chat.noMessages");
  if (message.deleted) return t("chat.deleted");
  const who = message.authorId === state.me.id ? `${t("chat.you")}: ` : conversation.kind === "channel" ? `${message.authorName}: ` : "";
  if (message.text) return `${who}${message.text}`;
  const first = message.attachments[0];
  if (!first) return who;
  return `${who}${first.kind === "image" ? `📷 ${t("chat.photo")}` : first.kind === "audio" ? `🎤 ${t("chat.voice")}` : `📎 ${first.name}`}`;
}

function listItem(conversation) {
  const last = conversation.lastMessage;
  return `<button type="button" class="chat-item ${conversation.id === activeId ? "active" : ""}" data-open="${esc(conversation.id)}">
    ${avatar(conversation)}
    <span class="chat-item-body">
      <strong>${esc(conversationTitle(conversation))}</strong>
      <small>${esc(previewOf(last, conversation))}</small>
    </span>
    <span class="chat-item-meta">
      ${last ? `<time>${esc(clockOf(last.createdAt))}</time>` : ""}
      ${conversation.unread ? `<b class="chat-unread${conversation.mentioned ? " mention" : ""}">${conversation.unread}</b>` : ""}
    </span>
  </button>`;
}

function attachmentHTML(message, file) {
  const href = `/api/messenger/${encodeURIComponent(message.conversationId)}/files/${encodeURIComponent(file.id)}`;
  if (file.kind === "image") {
    return `<a class="chat-att-image" href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="${esc(file.name)}" loading="lazy"></a>`;
  }
  if (file.kind === "audio") {
    return `<div class="chat-att-audio">
      <audio controls preload="none" src="${href}"></audio>
      ${file.duration ? `<small>${esc(durationOf(file.duration))}</small>` : ""}
      ${file.transcript ? `<p class="chat-transcript">${esc(file.transcript)}</p>` : ""}
    </div>`;
  }
  return `<a class="chat-att-file" href="${href}" target="_blank" rel="noopener">${icon("file")}<span><strong>${esc(file.name)}</strong><small>${esc(sizeOf(file.size))}</small></span>${icon("download")}</a>`;
}

function reactionsHTML(message) {
  const entries = Object.entries(message.reactions || {});
  if (!entries.length) return "";
  return `<div class="chat-reactions">${entries.map(([emoji, ids]) => `
    <button type="button" class="chat-reaction ${ids.includes(state.me.id) ? "mine" : ""}" data-react="${esc(message.id)}" data-emoji="${esc(emoji)}" title="${esc(ids.map((id) => byId(id)?.name || id).join(", "))}">${emoji} ${ids.length}</button>`).join("")}</div>`;
}

// A tick per message would be noise in a channel; the author sees one mark on
// their own last message instead, which is the only place it answers a question.
function receiptFor(message, conversation) {
  if (message.authorId !== state.me.id || message.kind === "system") return "";
  if (messages.filter((item) => item.authorId === state.me.id).at(-1)?.id !== message.id) return "";
  const others = Object.entries(readBy);
  if (!others.length) return "";
  const seen = others.filter(([, readAt]) => readAt && readAt >= message.createdAt);
  if (!seen.length) return `<span class="chat-receipt">${icon("check")}</span>`;
  const label = conversation.kind === "channel" ? t("chat.seenBy", { count: seen.length }) : t("chat.seen");
  return `<span class="chat-receipt seen" title="${esc(seen.map(([id]) => byId(id)?.name || id).join(", "))}">${icon("check")}${icon("check")}<i>${esc(label)}</i></span>`;
}

function messageHTML(message, conversation, showAuthor) {
  const mine = message.authorId === state.me.id;
  if (message.kind === "system") return `<div class="chat-system">${esc(message.text)}</div>`;
  if (message.deleted) {
    return `<div class="chat-msg ${mine ? "mine" : ""}"><div class="chat-bubble deleted">${t("chat.deleted")}</div></div>`;
  }
  const mentionsMe = (message.mentions || []).includes(state.me.id);
  return `<div class="chat-msg ${mine ? "mine" : ""} ${message.kind === "agent" ? "agent" : ""}" data-message="${esc(message.id)}">
    ${showAuthor && !mine ? `<span class="chat-msg-author">${esc(message.authorName)}</span>` : ""}
    <div class="chat-bubble${mentionsMe ? " mentioned" : ""}">
      ${message.replyTo ? `<div class="chat-quote" data-jump="${esc(message.replyTo.id)}"><strong>${esc(message.replyTo.authorName)}</strong><span>${esc(message.replyTo.excerpt)}</span></div>` : ""}
      ${message.attachments.map((file) => attachmentHTML(message, file)).join("")}
      ${message.text ? `<div class="chat-text">${esc(message.text)}</div>` : ""}
      <time>${message.editedAt ? `<i>${t("chat.edited")}</i> ` : ""}${esc(clockOf(message.createdAt))}</time>
    </div>
    ${reactionsHTML(message)}
    ${receiptFor(message, conversation)}
    <div class="chat-actions">
      <button type="button" class="icon-btn sm" data-reply="${esc(message.id)}" title="${t("chat.reply")}">${icon("branch")}</button>
      <button type="button" class="icon-btn sm" data-react-open="${esc(message.id)}" title="${t("chat.react")}">${icon("smile")}</button>
      ${mine ? `<button type="button" class="icon-btn sm" data-edit="${esc(message.id)}" title="${t("chat.edit")}">${icon("edit")}</button>` : ""}
      ${mine || canModerate() ? `<button type="button" class="icon-btn sm" data-delete="${esc(message.id)}" title="${t("chat.delete")}">${icon("trash")}</button>` : ""}
      ${conversation.kind === "channel" ? `<button type="button" class="icon-btn sm" data-pin="${esc(message.id)}" title="${t("chat.pin")}">${icon("key")}</button>` : ""}
    </div>
    ${reactingTo === message.id ? `<div class="chat-react-picker">${(state.reactions || []).map((emoji) => `<button type="button" data-react="${esc(message.id)}" data-emoji="${esc(emoji)}">${emoji}</button>`).join("")}</div>` : ""}
  </div>`;
}

function threadBody(conversation) {
  if (loadingThread) return `<div class="skeleton" style="height:120px"></div>`;
  if (!messages.length) return `<div class="chat-empty small">${icon("chat")}<p>${t("chat.startHint")}</p></div>`;
  const firstUnread = conversation.firstUnreadAt || "";
  let lastDay = "";
  let lastAuthor = "";
  let dividerShown = false;
  const rows = messages.map((message) => {
    const day = dayOf(message.createdAt);
    const parts = [];
    if (day !== lastDay) { parts.push(`<div class="chat-day">${esc(day)}</div>`); lastDay = day; lastAuthor = ""; }
    if (!dividerShown && firstUnread && message.createdAt >= firstUnread && message.authorId !== state.me.id) {
      parts.push(`<div class="chat-new-line"><span>${t("chat.newMessages")}</span></div>`);
      dividerShown = true;
    }
    const showAuthor = message.authorId !== lastAuthor;
    lastAuthor = message.authorId;
    parts.push(messageHTML(message, conversation, showAuthor));
    return parts.join("");
  }).join("");
  return `${hasMore ? `<button type="button" class="chat-older" data-older>${loadingOlder ? t("chat.loading") : t("chat.loadOlder")}</button>` : ""}${rows}`;
}

function composerHTML() {
  const typingList = [...typingNames.values()];
  return `${replyTo ? `<div class="chat-reply-bar">${icon("branch")}<div><strong>${esc(replyTo.authorName)}</strong><small>${esc(replyTo.excerpt)}</small></div><button type="button" class="icon-btn sm" data-cancel-reply>${icon("x")}</button></div>` : ""}
    ${editing ? `<div class="chat-reply-bar editing">${icon("edit")}<div><strong>${t("chat.editing")}</strong></div><button type="button" class="icon-btn sm" data-cancel-edit>${icon("x")}</button></div>` : ""}
    ${pending.length ? `<div class="chat-pending">${pending.map((file, index) => `<span>${file.kind === "image" ? "📷" : file.kind === "audio" ? "🎤" : "📎"} ${esc(file.name)}<button type="button" data-drop="${index}">${icon("x")}</button></span>`).join("")}</div>` : ""}
    ${typingList.length ? `<div class="chat-typing">${esc(t("chat.typing", { names: typingList.join(", ") }))}</div>` : ""}
    <form class="chat-composer" data-send>
      <label class="icon-btn" title="${t("chat.attach")}">${icon("attach")}<input type="file" data-file hidden multiple></label>
      <textarea rows="1" data-input maxlength="4000" placeholder="${t("chat.placeholder")}"></textarea>
      <button type="button" class="icon-btn ${recorder ? "recording" : ""}" data-record title="${t("chat.voice")}">${icon("mic")}</button>
      <button class="btn btn-primary" type="submit" ${sending ? "disabled" : ""}>${icon("send")}</button>
    </form>`;
}

function membersPanel(conversation) {
  const members = conversation.memberIds.map((id) => byId(id)).filter(Boolean);
  const outside = state.people.filter((person) => !conversation.memberIds.includes(person.id));
  const owner = conversation.createdBy === state.me.id || canModerate();
  return `<div class="chat-members">
    <header><strong>${t("chat.membersTitle")}</strong><button type="button" class="icon-btn sm" data-close-members>${icon("x")}</button></header>
    <div class="chat-members-list">
      ${members.map((person) => `<div class="chat-member">
        <span class="chat-avatar${person.online ? " online" : ""}">${isAgent(person.id) ? icon("sparkles") : esc(initials(person.name))}</span>
        <span><strong>${esc(person.name)}</strong><small>${esc(isAgent(person.id) ? t("chat.assistant") : person.role)}</small></span>
        ${owner && person.id !== conversation.createdBy ? `<button type="button" class="icon-btn sm" data-remove-member="${esc(person.id)}" title="${t("chat.remove")}">${icon("x")}</button>` : ""}
      </div>`).join("")}
    </div>
    ${owner && outside.length ? `<div class="chat-members-add">
      <small>${t("chat.addMember")}</small>
      ${outside.map((person) => `<button type="button" class="btn btn-ghost sm" data-add-member="${esc(person.id)}">${icon("plus")}${esc(person.name)}</button>`).join("")}
    </div>` : ""}
    <button type="button" class="btn btn-secondary sm chat-leave" data-leave>${t("chat.leave")}</button>
  </div>`;
}

function threadHTML() {
  const conversation = active();
  if (!conversation) {
    return `<div class="chat-empty">${icon("chat")}<h4>${t("chat.pickTitle")}</h4><p>${t("chat.pickHint")}</p></div>`;
  }
  const subtitle = conversation.kind === "channel"
    ? (conversation.topic || t("chat.members", { count: conversation.memberIds.length }))
    : (isAgent(conversation.otherId) ? t("chat.assistant") : (byId(conversation.otherId)?.online ? t("chat.online") : byId(conversation.otherId)?.role || ""));
  const pinned = conversation.pinnedMessageId ? messages.find((message) => message.id === conversation.pinnedMessageId) : null;
  return `<header class="chat-thread-head">
      <button type="button" class="icon-btn chat-back" data-back aria-label="${t("chat.back")}">${icon("chevleft")}</button>
      ${avatar(conversation)}
      <div><strong>${esc(conversationTitle(conversation))}</strong><small>${esc(subtitle)}</small></div>
      <div class="spacer"></div>
      ${conversation.kind === "channel" ? `<button type="button" class="icon-btn" data-members title="${t("chat.membersTitle")}">${icon("agents")}</button>` : ""}
    </header>
    ${pinned ? `<div class="chat-pinned">${icon("key")}<span>${esc(pinned.text || t("chat.photo"))}</span><button type="button" class="icon-btn sm" data-unpin>${icon("x")}</button></div>` : ""}
    ${showMembers && conversation.kind === "channel" ? membersPanel(conversation) : ""}
    <div class="chat-thread" id="chatThread">${threadBody(conversation)}</div>
    ${composerHTML()}`;
}

function sidebarHTML() {
  const query = search.trim().toLowerCase();
  const shown = state.conversations.filter((conversation) => !query
    || conversationTitle(conversation).toLowerCase().includes(query));
  const others = state.people.filter((person) => person.id !== state.me.id);
  return `<div class="chat-list">
      ${searchResults ? `<div class="chat-people-head">${t("chat.foundMessages", { count: searchResults.length })}</div>
        ${searchResults.map((hit) => `<button type="button" class="chat-item" data-open="${esc(hit.conversationId)}" data-jump-to="${esc(hit.message.id)}">
          <span class="chat-avatar channel">${icon("search")}</span>
          <span class="chat-item-body"><strong>${esc(hit.conversationName || t("chat.direct"))}</strong><small>${esc(hit.message.authorName)}: ${esc(hit.message.text)}</small></span>
          <span class="chat-item-meta"><time>${esc(clockOf(hit.message.createdAt))}</time></span>
        </button>`).join("")}` : ""}
      ${shown.length ? shown.map(listItem).join("") : (searchResults ? "" : `<div class="chat-empty small"><p>${t("chat.nothingFound")}</p></div>`)}
      <div class="chat-people-head">${t("chat.people")}</div>
      ${others.map((person) => `<button type="button" class="chat-person" data-direct="${esc(person.id)}">
        <span class="chat-avatar ${isAgent(person.id) ? "agent" : ""}${person.online && !isAgent(person.id) ? " online" : ""}">${isAgent(person.id) ? icon("sparkles") : esc(initials(person.name))}</span>
        <span><strong>${esc(person.name)}</strong><small>${esc(isAgent(person.id) ? t("chat.assistant") : person.role)}</small></span>
      </button>`).join("")}
    </div>`;
}

function render() {
  if (error) {
    return `<div class="page-head"><div><div class="page-title">${t("chat.title")}</div></div></div>
      <div class="alert error"><div class="a-body"><div class="a-title">${t("chat.unavailable")}</div><div class="a-desc">${esc(error)}</div></div></div>`;
  }
  if (!state) {
    return `<div class="page-head"><div><div class="page-title">${t("chat.title")}</div><div class="page-sub">${t("chat.subtitle")}</div></div></div>
      <div class="card pad-lg"><div class="skeleton" style="height:320px"></div></div>`;
  }
  return `<div class="page-head">
      <div><div class="page-title">${t("chat.title")}</div><div class="page-sub">${t("chat.subtitle")}</div></div>
      <div class="spacer"></div>
      <button class="btn btn-secondary" data-new-channel>${icon("plus")}${t("chat.newChannel")}</button>
    </div>
    <div class="chat-layout ${activeId ? "thread-open" : ""}">
      <aside class="chat-side">
        <div class="chat-search">${icon("search")}<input data-search value="${esc(search)}" placeholder="${t("chat.search")}"/></div>
        ${sidebarHTML()}
      </aside>
      <section class="chat-main">${threadHTML()}</section>
    </div>`;
}

// ---------- data ----------

async function loadOverview() {
  try {
    const result = await api.messenger.overview();
    if (!result?.me || !Array.isArray(result.conversations)) throw new Error("Unexpected response from the chat service");
    state = {
      ...result,
      people: Array.isArray(result.people) ? result.people : [],
      reactions: Array.isArray(result.reactions) ? result.reactions : [],
    };
    error = "";
  } catch (failure) {
    state = null;
    error = failure.message;
  }
}

async function openConversation(id, jumpTo = "") {
  activeId = id;
  loadingThread = true;
  messages = [];
  replyTo = null;
  editing = null;
  pending = [];
  showMembers = false;
  rerender();
  try {
    const result = await api.messenger.messages(id);
    // Defaulted rather than trusted: a response that is not the shape we expect
    // — a session that expired mid-request, a proxy error page — used to leave
    // `messages` undefined and throw out of the render on the next line.
    messages = Array.isArray(result?.messages) ? result.messages : [];
    readBy = result?.readBy || {};
    hasMore = !!result?.hasMore;
    await api.messenger.markRead(id);
    const conversation = state?.conversations.find((item) => item.id === id);
    if (conversation) conversation.unread = 0;
  } catch (failure) {
    messages = [];
    toast("error", failure.message);
  }
  loadingThread = false;
  rerender();
  if (jumpTo) jumpToMessage(jumpTo);
  else scrollThread();
}

function jumpToMessage(id) {
  const target = mountRoot?.querySelector(`[data-message="${CSS.escape(id)}"]`);
  if (!target) return;
  target.scrollIntoView({ block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1200);
}

async function loadOlder() {
  if (loadingOlder || !messages.length) return;
  loadingOlder = true;
  rerender();
  try {
    const result = await api.messenger.messages(activeId, { before: messages[0].createdAt });
    messages = [...(Array.isArray(result?.messages) ? result.messages : []), ...messages];
    hasMore = !!result?.hasMore;
  } catch (failure) { toast("error", failure.message); }
  loadingOlder = false;
  rerender();
}

function scrollThread() {
  const thread = mountRoot?.querySelector("#chatThread");
  if (thread) thread.scrollTop = thread.scrollHeight;
}

// A burst of incoming messages should not become a burst of read receipts.
function markReadSoon(id) {
  if (Date.now() - markReadAt < 2000) return;
  markReadAt = Date.now();
  api.messenger.markRead(id).catch(() => {});
}

function upsert(message) {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index >= 0) messages[index] = message;
  else messages = [...messages, message];
}

// ---------- attachments ----------

const readAsBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",").at(-1));
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

async function attach(file, extra = {}) {
  const base64 = await readAsBase64(file);
  const uploaded = await api.messenger.upload(activeId, {
    name: file.name, type: file.type || "application/octet-stream", base64, ...extra,
  });
  pending = [...pending, uploaded.file];
  rerender();
}

async function toggleRecording(root) {
  if (recorder) {
    recorder.stop();
    return;
  }
  try {
    const media = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    recorder = new MediaRecorder(media);
    recordingSince = Date.now();
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      media.getTracks().forEach((track) => track.stop());
      const seconds = (Date.now() - recordingSince) / 1000;
      recorder = null;
      rerender();
      const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
      if (blob.size < 1200) return;
      try {
        // Transcribed on the way in, so a voice note is searchable and readable
        // by someone who cannot listen right now.
        const transcript = await api.speech.transcribe(blob).catch(() => "");
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type });
        await attach(file, { duration: seconds, transcript });
      } catch (failure) { toast("error", failure.message); }
    };
    recorder.start();
    rerender();
  } catch (failure) {
    toast("error", t("chat.micDenied"), failure.message);
  }
}

// ---------- wiring ----------

function wire(root) {
  root.querySelectorAll("[data-open]").forEach((button) => button.onclick = () => {
    searchResults = null;
    openConversation(button.dataset.open, button.dataset.jumpTo || "");
  });
  root.querySelector("[data-back]")?.addEventListener("click", () => { activeId = ""; rerender(); });
  root.querySelector("[data-members]")?.addEventListener("click", () => { showMembers = !showMembers; rerender(); });
  root.querySelector("[data-close-members]")?.addEventListener("click", () => { showMembers = false; rerender(); });

  root.querySelector("[data-search]")?.addEventListener("input", (event) => {
    search = event.target.value;
    clearTimeout(searchTimer);
    const query = search.trim();
    searchTimer = setTimeout(async () => {
      searchResults = query.length >= 2 ? (await api.messenger.search(query).catch(() => ({ results: [] }))).results : null;
      rerender();
      root.querySelector("[data-search]")?.focus();
    }, 300);
  });

  root.querySelectorAll("[data-direct]").forEach((button) => button.onclick = async () => {
    button.disabled = true;
    try {
      const conversation = await api.messenger.openDirect(button.dataset.direct);
      await loadOverview();
      await openConversation(conversation.id);
    } catch (failure) { button.disabled = false; toast("error", failure.message); }
  });

  root.querySelector("[data-new-channel]")?.addEventListener("click", async () => {
    const name = prompt(t("chat.newChannelPrompt"));
    if (!name) return;
    try {
      const memberIds = state.people.filter((person) => !isAgent(person.id)).map((person) => person.id);
      const conversation = await api.messenger.createChannel({ name, memberIds });
      await loadOverview();
      await openConversation(conversation.id);
    } catch (failure) { toast("error", failure.message); }
  });

  root.querySelectorAll("[data-reply]").forEach((button) => button.onclick = () => {
    const message = messages.find((item) => item.id === button.dataset.reply);
    replyTo = { id: message.id, authorName: message.authorName, excerpt: (message.text || "📎").slice(0, 160) };
    editing = null;
    rerender();
    root.querySelector("[data-input]")?.focus();
  });
  root.querySelector("[data-cancel-reply]")?.addEventListener("click", () => { replyTo = null; rerender(); });
  root.querySelector("[data-cancel-edit]")?.addEventListener("click", () => { editing = null; rerender(); });

  root.querySelectorAll("[data-edit]").forEach((button) => button.onclick = () => {
    const message = messages.find((item) => item.id === button.dataset.edit);
    editing = message.id;
    replyTo = null;
    rerender();
    const input = root.querySelector("[data-input]");
    if (input) { input.value = message.text; input.focus(); }
  });

  root.querySelectorAll("[data-delete]").forEach((button) => button.onclick = async () => {
    if (!confirm(t("chat.deleteConfirm"))) return;
    try {
      const updated = await api.messenger.remove(activeId, button.dataset.delete);
      upsert(updated);
      rerender();
    } catch (failure) { toast("error", failure.message); }
  });

  root.querySelectorAll("[data-react-open]").forEach((button) => button.onclick = () => {
    reactingTo = reactingTo === button.dataset.reactOpen ? "" : button.dataset.reactOpen;
    rerender();
  });
  root.querySelectorAll("[data-react]").forEach((button) => button.onclick = async () => {
    reactingTo = "";
    try {
      const updated = await api.messenger.react(activeId, button.dataset.react, button.dataset.emoji);
      upsert(updated);
      rerender();
    } catch (failure) { toast("error", failure.message); }
  });

  root.querySelectorAll("[data-pin]").forEach((button) => button.onclick = async () => {
    try {
      const conversation = await api.messenger.pin(activeId, button.dataset.pin);
      Object.assign(active(), conversation);
      rerender();
    } catch (failure) { toast("error", failure.message); }
  });
  root.querySelector("[data-unpin]")?.addEventListener("click", async () => {
    const conversation = await api.messenger.pin(activeId, "");
    Object.assign(active(), conversation);
    rerender();
  });

  root.querySelectorAll("[data-jump]").forEach((element) => element.onclick = () => jumpToMessage(element.dataset.jump));
  root.querySelector("[data-older]")?.addEventListener("click", loadOlder);

  root.querySelectorAll("[data-add-member], [data-remove-member]").forEach((button) => button.onclick = async () => {
    const conversation = active();
    const add = button.dataset.addMember;
    const memberIds = add
      ? [...conversation.memberIds, add]
      : conversation.memberIds.filter((id) => id !== button.dataset.removeMember);
    try {
      const updated = await api.messenger.updateChannel(activeId, { memberIds });
      Object.assign(conversation, updated);
      await loadOverview();
      rerender();
    } catch (failure) { toast("error", failure.message); }
  });
  root.querySelector("[data-leave]")?.addEventListener("click", async () => {
    if (!confirm(t("chat.leaveConfirm"))) return;
    try {
      await api.messenger.leaveChannel(activeId);
      activeId = "";
      await loadOverview();
      rerender();
    } catch (failure) { toast("error", failure.message); }
  });

  root.querySelector("[data-file]")?.addEventListener("change", async (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    for (const file of files) {
      try { await attach(file); } catch (failure) { toast("error", failure.message); }
    }
  });
  root.querySelectorAll("[data-drop]").forEach((button) => button.onclick = () => {
    pending = pending.filter((_, index) => index !== Number(button.dataset.drop));
    rerender();
  });
  root.querySelector("[data-record]")?.addEventListener("click", () => toggleRecording(root));

  const form = root.querySelector("[data-send]");
  const input = root.querySelector("[data-input]");
  const submit = async (event) => {
    event?.preventDefault();
    const text = input.value.trim();
    if ((!text && !pending.length) || sending) return;
    sending = true;
    const attachments = pending;
    const reply = replyTo;
    const editId = editing;
    input.value = "";
    pending = [];
    replyTo = null;
    editing = null;
    try {
      const message = editId
        ? await api.messenger.edit(activeId, editId, text)
        : await api.messenger.send(activeId, { text, attachments, replyToId: reply?.id || "" });
      upsert(message);
      rerender();
      scrollThread();
    } catch (failure) {
      input.value = text;
      pending = attachments;
      replyTo = reply;
      editing = editId;
      toast("error", failure.message);
    }
    sending = false;
  };
  form?.addEventListener("submit", submit);
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) submit(event);
  });
  input?.addEventListener("input", () => {
    // One ping per few seconds is enough to keep the indicator alive.
    if (Date.now() - lastTypingSent < 3000 || !activeId) return;
    lastTypingSent = Date.now();
    api.messenger.typing(activeId).catch(() => {});
  });

  const thread = root.querySelector("#chatThread");
  thread?.addEventListener("scroll", () => {
    if (thread.scrollTop < 40 && hasMore && !loadingOlder) loadOlder();
  });
}

export default {
  get title() { return t("chat.title"); },
  render,
  async mount(root, ctx) {
    mountRoot = root;
    await loadOverview();
    const requested = ctx?.params?.[0];
    if (requested && state?.conversations.some((conversation) => conversation.id === requested)) activeId = requested;
    root.innerHTML = render();
    wire(root);
    // Only fetch the thread when this mount actually needs it. mount() runs again
    // on every route change, and reloading a conversation already in memory is
    // both wasted requests and a visible flicker.
    if (activeId && (!messages.length || messages[0]?.conversationId !== activeId)) {
      await openConversation(activeId);
    } else if (activeId) {
      rerender();
    }

    if (!stream && window.EventSource) {
      stream = api.messenger.stream({
        message: ({ conversationId, message }) => {
          if (conversationId === activeId) {
            upsert(message);
            markReadSoon(activeId);
            rerender();
            scrollThread();
          } else {
            const conversation = state?.conversations.find((item) => item.id === conversationId);
            if (conversation && message.authorId !== state.me.id) {
              conversation.unread += 1;
              conversation.lastMessage = message;
              if ((message.mentions || []).includes(state.me.id)) conversation.mentioned = true;
              rerender();
            }
          }
        },
        updated: ({ conversationId, message }) => {
          if (conversationId !== activeId) return;
          upsert(message);
          rerender();
        },
        conversation: () => { loadOverview().then(rerender); },
        typing: ({ conversationId, userId, name }) => {
          if (conversationId !== activeId) return;
          typingNames.set(userId, name);
          rerender();
          clearTimeout(typingTimer);
          typingTimer = setTimeout(() => { typingNames.clear(); rerender(); }, 5000);
        },
        read: ({ conversationId, userId, readAt }) => {
          if (conversationId !== activeId) return;
          readBy = { ...readBy, [userId]: readAt };
          rerender();
        },
      });
      stream.onerror = () => { stream?.close(); stream = null; };
    }
  },
  unmount() {
    mountRoot = null;
    stream?.close();
    stream = null;
    clearTimeout(typingTimer);
    clearTimeout(searchTimer);
    if (recorder) { try { recorder.stop(); } catch { /* already stopped */ } recorder = null; }
  },
};
