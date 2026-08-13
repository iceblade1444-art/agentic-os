// The corporate messenger: channels for the team, direct messages between people.
//
// Deliberately separate from `member-workspace.js`, whose `chatMessages` are the
// MILA assistant transcript synced with the phone app. Those are one person
// talking to an assistant; these are people talking to each other, and mixing
// the two would break the mobile sync as soon as a colleague wrote something.
//
// Storage is one index for conversations and read state, plus one file per
// conversation for its messages, so opening a busy channel never reads every
// other conversation in the company.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";

export const MILA_MEMBER_ID = "agent:mila";
const KINDS = new Set(["channel", "direct"]);
const MESSAGE_KINDS = new Set(["user", "agent", "system"]);
const MAX_TEXT = 4000;
const MAX_NAME = 80;
const MAX_TOPIC = 200;
const MAX_MESSAGES_PER_CONVERSATION = 5000;
const MAX_MEMBERS = 200;

const now = () => new Date().toISOString();
const clean = (value, max) => String(value ?? "").trim().slice(0, max);
const oneLine = (value, max) => clean(value, max).replace(/\s+/g, " ");

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  hardenRuntimeFile(file, 0o600);
}

function publicConversation(conversation) {
  return {
    id: conversation.id,
    kind: conversation.kind,
    name: conversation.name,
    topic: conversation.topic || "",
    memberIds: [...conversation.memberIds],
    createdBy: conversation.createdBy,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

function publicMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    authorId: message.authorId,
    authorName: message.authorName,
    kind: MESSAGE_KINDS.has(message.kind) ? message.kind : "user",
    text: message.text,
    mentions: Array.isArray(message.mentions) ? message.mentions : [],
    createdAt: message.createdAt,
  };
}

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export class Messenger extends EventEmitter {
  constructor(baseDir = path.join(path.resolve(config.dataDir), "messenger")) {
    super();
    this.baseDir = baseDir;
    this.indexFile = path.join(baseDir, "index.json");
    this.setMaxListeners(0);
  }

  #index() {
    const value = readJson(this.indexFile, {});
    return {
      conversations: Array.isArray(value.conversations) ? value.conversations : [],
      // reads[userId][conversationId] = ISO timestamp of the last message seen
      reads: value.reads && typeof value.reads === "object" ? value.reads : {},
      lastStamp: typeof value.lastStamp === "string" ? value.lastStamp : "",
    };
  }

  // Message order, pagination and unread counts all hang off the timestamp, and
  // two messages sent in the same millisecond would share one — leaving the
  // order of a burst undefined and letting a message land exactly on someone's
  // read watermark. Stamps are therefore issued strictly increasing.
  #stamp(index) {
    const previous = Date.parse(index.lastStamp) || 0;
    const stamp = new Date(Math.max(Date.now(), previous + 1)).toISOString();
    index.lastStamp = stamp;
    return stamp;
  }

  #saveIndex(index) {
    writeJson(this.indexFile, index);
  }

  #messagesFile(conversationId) {
    // Ids are generated here, but a caller-supplied one must never escape the dir.
    const safe = String(conversationId).replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safe) fail("Invalid conversation id");
    return path.join(this.baseDir, `messages-${safe}.json`);
  }

  #messages(conversationId) {
    const value = readJson(this.#messagesFile(conversationId), []);
    return Array.isArray(value) ? value : [];
  }

  #conversationFor(index, conversationId, userId) {
    const conversation = index.conversations.find((item) => item.id === conversationId);
    if (!conversation) fail("Conversation not found", 404);
    // Membership is the whole access model: there are no public channels a
    // non-member can read.
    if (!conversation.memberIds.includes(userId)) fail("You are not a member of this conversation", 403);
    return conversation;
  }

  // ---------- reading ----------

  listFor(userId) {
    const index = this.#index();
    const reads = index.reads[userId] || {};
    return index.conversations
      .filter((conversation) => conversation.memberIds.includes(userId))
      .map((conversation) => {
        const messages = this.#messages(conversation.id);
        const last = messages.at(-1) || null;
        const readAt = reads[conversation.id] || "";
        const unread = messages.filter((message) => message.createdAt > readAt && message.authorId !== userId).length;
        return {
          ...publicConversation(conversation),
          unread,
          lastMessage: last ? publicMessage(last) : null,
          lastActivityAt: last?.createdAt || conversation.createdAt,
        };
      })
      .sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
  }

  messages(conversationId, userId, { limit = 50, before = "" } = {}) {
    const index = this.#index();
    this.#conversationFor(index, conversationId, userId);
    const bounded = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const all = this.#messages(conversationId);
    const filtered = before ? all.filter((message) => message.createdAt < before) : all;
    return {
      messages: filtered.slice(-bounded).map(publicMessage),
      hasMore: filtered.length > bounded,
    };
  }

  unreadTotal(userId) {
    return this.listFor(userId).reduce((total, conversation) => total + conversation.unread, 0);
  }

  // ---------- conversations ----------

  createChannel(user, input = {}) {
    const name = oneLine(input.name, MAX_NAME);
    if (name.length < 2) fail("Channel name must contain at least 2 characters");
    const index = this.#index();
    const memberIds = [...new Set([user.id, ...(Array.isArray(input.memberIds) ? input.memberIds : [])])]
      .map((id) => clean(id, 120))
      .filter(Boolean)
      .slice(0, MAX_MEMBERS);
    const conversation = {
      id: `cnv_${crypto.randomUUID()}`,
      kind: "channel",
      name,
      topic: oneLine(input.topic, MAX_TOPIC),
      memberIds,
      createdBy: user.id,
      createdAt: now(),
      updatedAt: now(),
    };
    index.conversations.push(conversation);
    this.#saveIndex(index);
    this.emit("conversation", { conversation: publicConversation(conversation) });
    return publicConversation(conversation);
  }

  updateChannel(user, conversationId, input = {}) {
    const index = this.#index();
    const conversation = this.#conversationFor(index, conversationId, user.id);
    if (conversation.kind !== "channel") fail("Only channels can be edited");
    // Anyone in the channel can retitle it; only its creator or an operator can
    // change who is in it, because that is what controls access.
    if (Object.hasOwn(input, "name")) {
      const name = oneLine(input.name, MAX_NAME);
      if (name.length < 2) fail("Channel name must contain at least 2 characters");
      conversation.name = name;
    }
    if (Object.hasOwn(input, "topic")) conversation.topic = oneLine(input.topic, MAX_TOPIC);
    if (Object.hasOwn(input, "memberIds")) {
      const operator = ["Creator", "Admin"].includes(user.role);
      if (!operator && conversation.createdBy !== user.id) fail("Only the channel owner can change its members", 403);
      const memberIds = [...new Set([conversation.createdBy, ...input.memberIds.map((id) => clean(id, 120))])]
        .filter(Boolean)
        .slice(0, MAX_MEMBERS);
      conversation.memberIds = memberIds;
    }
    conversation.updatedAt = now();
    this.#saveIndex(index);
    this.emit("conversation", { conversation: publicConversation(conversation) });
    return publicConversation(conversation);
  }

  // A direct conversation is identified by its pair, so opening one twice from
  // two devices cannot produce two threads with the same person.
  openDirect(user, otherId) {
    const other = clean(otherId, 120);
    if (!other) fail("Choose someone to write to");
    if (other === user.id) fail("You cannot open a chat with yourself");
    const index = this.#index();
    const existing = index.conversations.find((conversation) => conversation.kind === "direct"
      && conversation.memberIds.length === 2
      && conversation.memberIds.includes(user.id)
      && conversation.memberIds.includes(other));
    if (existing) return publicConversation(existing);
    const conversation = {
      id: `cnv_${crypto.randomUUID()}`,
      kind: "direct",
      name: "",
      topic: "",
      memberIds: [user.id, other],
      createdBy: user.id,
      createdAt: now(),
      updatedAt: now(),
    };
    index.conversations.push(conversation);
    this.#saveIndex(index);
    this.emit("conversation", { conversation: publicConversation(conversation) });
    return publicConversation(conversation);
  }

  // ---------- messages ----------

  send(conversationId, author, input = {}) {
    const text = clean(input.text, MAX_TEXT);
    if (!text) fail("A message cannot be empty");
    const index = this.#index();
    const conversation = this.#conversationFor(index, conversationId, author.id);

    const message = {
      id: `msg_${crypto.randomUUID()}`,
      conversationId,
      authorId: author.id,
      authorName: clean(author.name, MAX_NAME) || "—",
      kind: MESSAGE_KINDS.has(input.kind) ? input.kind : "user",
      text,
      mentions: Array.isArray(input.mentions) ? input.mentions.map((id) => clean(id, 120)).filter(Boolean) : [],
      createdAt: this.#stamp(index),
    };
    const messages = this.#messages(conversationId);
    messages.push(message);
    writeJson(this.#messagesFile(conversationId), messages.slice(-MAX_MESSAGES_PER_CONVERSATION));

    conversation.updatedAt = message.createdAt;
    // Sending is also reading: the author must not see their own message unread.
    index.reads[author.id] = { ...(index.reads[author.id] || {}), [conversationId]: message.createdAt };
    this.#saveIndex(index);

    const published = publicMessage(message);
    this.emit("message", { conversation: publicConversation(conversation), message: published });
    return published;
  }

  markRead(userId, conversationId) {
    const index = this.#index();
    this.#conversationFor(index, conversationId, userId);
    const messages = this.#messages(conversationId);
    const last = messages.at(-1);
    // With nothing to read, the watermark is the newest stamp ever issued rather
    // than the wall clock: every future message is then strictly newer than it.
    // Taking Date.now() here let a message written in the same millisecond land
    // exactly on the watermark and count as already read.
    const readAt = last?.createdAt || index.lastStamp || new Date(0).toISOString();
    index.reads[userId] = { ...(index.reads[userId] || {}), [conversationId]: readAt };
    this.#saveIndex(index);
    return { ok: true, readAt };
  }

  // Everyone a message should notify: members who are not the author and are
  // not agents, since an agent has no phone to wake.
  recipients(conversation, authorId) {
    return conversation.memberIds.filter((id) => id !== authorId && !id.startsWith("agent:"));
  }

  isMember(conversationId, userId) {
    const conversation = this.#index().conversations.find((item) => item.id === conversationId);
    return !!conversation && conversation.memberIds.includes(userId);
  }
}

// Finds @mentions against the people actually in the conversation, so a stray
// "@" in prose cannot notify anyone and a name that left the channel stops
// resolving.
export function parseMentions(text, members = []) {
  const found = new Set();
  const lowered = String(text || "").toLowerCase();
  for (const member of members) {
    const handle = String(member.handle || member.name || "").trim().toLowerCase();
    if (!handle) continue;
    const first = handle.split(/\s+/)[0];
    if (!first || first.length < 2) continue;
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])@${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "iu");
    if (pattern.test(lowered)) found.add(member.id);
  }
  return [...found];
}

export const messenger = new Messenger();
