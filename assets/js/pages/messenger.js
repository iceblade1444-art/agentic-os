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
let loadingThread = false;
let sending = false;
let stream = null;
let search = "";

const rerender = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
const byId = (id) => state?.people.find((person) => person.id === id) || null;
const isAgent = (id) => String(id || "").startsWith("agent:");

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

const active = () => state?.conversations.find((conversation) => conversation.id === activeId) || null;

function conversationTitle(conversation) {
  if (conversation.kind === "channel") return conversation.name;
  return conversation.name || t("chat.direct");
}

function avatar(conversation) {
  if (conversation.kind === "channel") return `<span class="chat-avatar channel">${icon("chat")}</span>`;
  if (isAgent(conversation.otherId)) return `<span class="chat-avatar agent">${icon("sparkles")}</span>`;
  return `<span class="chat-avatar">${esc(initials(conversationTitle(conversation)))}</span>`;
}

function listItem(conversation) {
  const last = conversation.lastMessage;
  const preview = last ? `${last.authorId === state.me.id ? `${t("chat.you")}: ` : conversation.kind === "channel" ? `${last.authorName}: ` : ""}${last.text}` : t("chat.noMessages");
  return `<button type="button" class="chat-item ${conversation.id === activeId ? "active" : ""}" data-open="${esc(conversation.id)}">
    ${avatar(conversation)}
    <span class="chat-item-body">
      <strong>${esc(conversationTitle(conversation))}</strong>
      <small>${esc(preview)}</small>
    </span>
    <span class="chat-item-meta">
      ${last ? `<time>${esc(clockOf(last.createdAt))}</time>` : ""}
      ${conversation.unread ? `<b class="chat-unread">${conversation.unread}</b>` : ""}
    </span>
  </button>`;
}

function messageGroup() {
  let lastDay = "";
  return messages.map((message) => {
    const mine = message.authorId === state.me.id;
    const day = dayOf(message.createdAt);
    const divider = day === lastDay ? "" : `<div class="chat-day">${esc(day)}</div>`;
    lastDay = day;
    if (message.kind === "system") {
      return `${divider}<div class="chat-system">${esc(message.text)}</div>`;
    }
    return `${divider}<div class="chat-msg ${mine ? "mine" : ""} ${message.kind === "agent" ? "agent" : ""}">
      ${mine ? "" : `<span class="chat-msg-author">${esc(message.authorName)}</span>`}
      <div class="chat-bubble">${esc(message.text)}<time>${esc(clockOf(message.createdAt))}</time></div>
    </div>`;
  }).join("");
}

function threadHTML() {
  const conversation = active();
  if (!conversation) {
    return `<div class="chat-empty">${icon("chat")}<h4>${t("chat.pickTitle")}</h4><p>${t("chat.pickHint")}</p></div>`;
  }
  const members = conversation.kind === "channel"
    ? t("chat.members", { count: conversation.memberIds.length })
    : (isAgent(conversation.otherId) ? t("chat.assistant") : byId(conversation.otherId)?.role || "");
  return `<header class="chat-thread-head">
      <button type="button" class="icon-btn chat-back" data-back aria-label="${t("chat.back")}">${icon("chevleft")}</button>
      ${avatar(conversation)}
      <div><strong>${esc(conversationTitle(conversation))}</strong><small>${esc(conversation.topic || members)}</small></div>
    </header>
    <div class="chat-thread" id="chatThread">${loadingThread
      ? `<div class="skeleton" style="height:120px"></div>`
      : messages.length ? messageGroup() : `<div class="chat-empty small">${icon("chat")}<p>${t("chat.startHint")}</p></div>`}</div>
    <form class="chat-composer" data-send>
      <textarea rows="1" data-input maxlength="4000" placeholder="${t("chat.placeholder")}"></textarea>
      <button class="btn btn-primary" type="submit" ${sending ? "disabled" : ""}>${icon("send")}</button>
    </form>`;
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
  const query = search.trim().toLowerCase();
  const shown = state.conversations.filter((conversation) => !query
    || conversationTitle(conversation).toLowerCase().includes(query)
    || (conversation.lastMessage?.text || "").toLowerCase().includes(query));
  const others = state.people.filter((person) => person.id !== state.me.id);

  return `<div class="page-head">
      <div><div class="page-title">${t("chat.title")}</div><div class="page-sub">${t("chat.subtitle")}</div></div>
      <div class="spacer"></div>
      <button class="btn btn-secondary" data-new-channel>${icon("plus")}${t("chat.newChannel")}</button>
    </div>
    <div class="chat-layout ${activeId ? "thread-open" : ""}">
      <aside class="chat-side">
        <div class="chat-search">${icon("search")}<input data-search value="${esc(search)}" placeholder="${t("chat.search")}"/></div>
        <div class="chat-list">
          ${shown.length ? shown.map(listItem).join("") : `<div class="chat-empty small"><p>${t("chat.nothingFound")}</p></div>`}
          <div class="chat-people-head">${t("chat.people")}</div>
          ${others.map((person) => `<button type="button" class="chat-person" data-direct="${esc(person.id)}">
            <span class="chat-avatar ${isAgent(person.id) ? "agent" : ""}">${isAgent(person.id) ? icon("sparkles") : esc(initials(person.name))}</span>
            <span><strong>${esc(person.name)}</strong><small>${esc(isAgent(person.id) ? t("chat.assistant") : person.role)}</small></span>
          </button>`).join("")}
        </div>
      </aside>
      <section class="chat-main">${threadHTML()}</section>
    </div>`;
}

async function loadOverview() {
  try {
    state = await api.messenger.overview();
    error = "";
  } catch (failure) {
    error = failure.message;
  }
}

async function openConversation(id) {
  activeId = id;
  loadingThread = true;
  messages = [];
  rerender();
  try {
    const result = await api.messenger.messages(id);
    messages = result.messages;
    await api.messenger.markRead(id);
    const conversation = state.conversations.find((item) => item.id === id);
    if (conversation) conversation.unread = 0;
  } catch (failure) {
    toast("error", failure.message);
  }
  loadingThread = false;
  rerender();
}

function scrollThread() {
  const thread = document.getElementById("chatThread");
  if (thread) thread.scrollTop = thread.scrollHeight;
}

function wire(root) {
  root.querySelectorAll("[data-open]").forEach((button) => button.onclick = () => openConversation(button.dataset.open));
  root.querySelector("[data-back]")?.addEventListener("click", () => { activeId = ""; rerender(); });
  root.querySelector("[data-search]")?.addEventListener("input", (event) => {
    search = event.target.value;
    const side = root.querySelector(".chat-list");
    const temp = document.createElement("div");
    temp.innerHTML = render();
    side.replaceWith(temp.querySelector(".chat-list"));
    wire(root);
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
      // Everyone in the workspace joins a new channel: this is a small company,
      // and a channel nobody is in is just a private note.
      const memberIds = state.people.filter((person) => !isAgent(person.id)).map((person) => person.id);
      const conversation = await api.messenger.createChannel({ name, memberIds });
      await loadOverview();
      await openConversation(conversation.id);
    } catch (failure) { toast("error", failure.message); }
  });

  const form = root.querySelector("[data-send]");
  const input = root.querySelector("[data-input]");
  const submit = async (event) => {
    event?.preventDefault();
    const text = input.value.trim();
    if (!text || sending) return;
    sending = true;
    input.value = "";
    try {
      const message = await api.messenger.send(activeId, text);
      if (!messages.some((item) => item.id === message.id)) messages = [...messages, message];
      rerender();
      scrollThread();
    } catch (failure) {
      input.value = text;
      toast("error", failure.message);
    }
    sending = false;
  };
  form?.addEventListener("submit", submit);
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) submit(event);
  });
  scrollThread();
}

export default {
  get title() { return t("chat.title"); },
  render,
  async mount(root, ctx) {
    await loadOverview();
    const requested = ctx?.params?.[0];
    if (requested && state?.conversations.some((conversation) => conversation.id === requested)) activeId = requested;
    root.innerHTML = render();
    wire(root);
    if (activeId) await openConversation(activeId);

    if (!stream && window.EventSource) {
      stream = api.messenger.stream(
        ({ conversationId, message }) => {
          if (conversationId === activeId) {
            if (!messages.some((item) => item.id === message.id)) messages = [...messages, message];
            api.messenger.markRead(activeId).catch(() => {});
            rerender();
            scrollThread();
          } else {
            const conversation = state?.conversations.find((item) => item.id === conversationId);
            if (conversation && message.authorId !== state.me.id) {
              conversation.unread += 1;
              conversation.lastMessage = message;
              rerender();
            }
          }
        },
        () => { loadOverview().then(rerender); },
      );
      stream.onerror = () => { stream?.close(); stream = null; };
    }
  },
  unmount() {
    stream?.close();
    stream = null;
  },
};
