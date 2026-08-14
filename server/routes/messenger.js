import express from "express";
import { Router } from "express";

import { authenticatedUser, creatorUser } from "../lib/auth.js";
import { messenger, parseMentions, MILA_MEMBER_ID, REACTIONS } from "../lib/messenger.js";
import { messengerFiles } from "../lib/messenger-files.js";
import { milaResponder, shouldMilaAnswer } from "../lib/messenger-mila.js";
import { pushService } from "../lib/push-service.js";
import { users } from "../lib/users.js";
import { messengerRecap } from "../lib/messenger-recap.js";

const r = Router();

const MILA_MEMBER = { id: MILA_MEMBER_ID, name: "Mila", handle: "mila", role: "Assistant", kind: "agent" };
// Attachments arrive as base64 in JSON, which is a third larger than the bytes
// it carries; the global 1 MB parser would reject a phone photo outright.
const uploadBody = express.json({ limit: "20mb" });

// Who is typing where, and who currently has the chat open. Both are worthless
// a minute later, so neither is persisted.
const typing = new Map();
const online = new Map();
const TYPING_TTL_MS = 6000;

function typingIn(conversationId, exceptUserId) {
  const entries = typing.get(conversationId) || new Map();
  const fresh = [];
  for (const [userId, at] of entries) {
    if (Date.now() - at > TYPING_TTL_MS) entries.delete(userId);
    else if (userId !== exceptUserId) fresh.push(userId);
  }
  if (!entries.size) typing.delete(conversationId);
  return fresh;
}

// Everyone who can be written to. The Creator lives in server configuration
// rather than the user store, so listing only the store would hide the owner.
function directory() {
  const people = [creatorUser(), ...users.list()]
    .filter((user) => user?.id && !user.disabled && user.approved !== false)
    .map((user) => ({
      id: user.id,
      name: user.name,
      handle: String(user.name || "").trim().split(/\s+/)[0].toLowerCase(),
      role: user.role,
      kind: "person",
      online: online.has(user.id),
    }));
  return [...people, { ...MILA_MEMBER, online: true }];
}

const nameFor = (id, people) => people.find((person) => person.id === id)?.name || id;

// A direct conversation has no name of its own: it is titled by the other person.
function decorate(conversation, userId, people) {
  if (conversation.kind !== "direct") return conversation;
  const otherId = conversation.memberIds.find((id) => id !== userId) || userId;
  return { ...conversation, name: nameFor(otherId, people), otherId };
}

r.get("/", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    const people = directory();
    res.json({
      me: { id: user.id, name: user.name, role: user.role },
      people,
      reactions: REACTIONS,
      conversations: messenger.listFor(user.id).map((conversation) => decorate(conversation, user.id, people)),
    });
  } catch (error) { next(error); }
});

r.get("/search", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    res.json({ results: messenger.search(user.id, req.query.q) });
  } catch (error) { next(error); }
});

r.post("/channels", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    res.status(201).json(messenger.createChannel(user, req.body || {}));
  } catch (error) { next(error); }
});

r.patch("/channels/:id", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    res.json(messenger.updateChannel(user, req.params.id, req.body || {}));
  } catch (error) { next(error); }
});

r.post("/channels/:id/leave", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    res.json(messenger.leaveChannel(user, req.params.id));
  } catch (error) { next(error); }
});

r.post("/direct", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    const conversation = messenger.openDirect(user, req.body?.userId);
    res.status(201).json(decorate(conversation, user.id, directory()));
  } catch (error) { next(error); }
});

r.get("/:id/messages", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    const result = messenger.messages(req.params.id, user.id, { limit: req.query.limit, before: req.query.before });
    res.json({ ...result, typing: typingIn(req.params.id, user.id) });
  } catch (error) { next(error); }
});

// A recap of what the caller missed in a thread they are a member of. The
// membership check lives inside messengerRecap, on the same call that fetches
// the messages.
r.post("/:id/recap", async (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    res.json(await messengerRecap.recap(user, req.params.id));
  } catch (error) { next(error); }
});

r.post("/:id/read", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    res.json(messenger.markRead(user.id, req.params.id));
  } catch (error) { next(error); }
});

r.post("/:id/pin", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    res.json(messenger.pin(user, req.params.id, req.body?.messageId || ""));
  } catch (error) { next(error); }
});

r.post("/:id/typing", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    if (!messenger.isMember(req.params.id, user.id)) return res.status(403).json({ error: "forbidden" });
    const entries = typing.get(req.params.id) || new Map();
    entries.set(user.id, Date.now());
    typing.set(req.params.id, entries);
    messenger.emit("typing", {
      conversationId: req.params.id,
      userId: user.id,
      name: user.name,
      memberIds: messenger.conversation(req.params.id, user.id).memberIds,
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

r.post("/:id/files", uploadBody, (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    // Membership is checked before a byte is written: an upload must not be a
    // way to put files on the server for a conversation you cannot read.
    if (!messenger.isMember(req.params.id, user.id)) return res.status(403).json({ error: "forbidden" });
    res.status(201).json({ file: messengerFiles.add(req.params.id, req.body || {}) });
  } catch (error) { next(error); }
});

r.get("/:id/files/:fileId", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    if (!messenger.isMember(req.params.id, user.id)) return res.status(403).json({ error: "forbidden" });
    const file = messengerFiles.get(req.params.id, req.params.fileId);
    res.setHeader("Content-Type", file.type);
    res.setHeader("Content-Disposition", `${file.kind === "file" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(file.buffer);
  } catch (error) { next(error); }
});

r.patch("/:id/messages/:messageId", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    res.json(messenger.edit(req.params.id, req.params.messageId, user, req.body?.text));
  } catch (error) { next(error); }
});

r.delete("/:id/messages/:messageId", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    res.json(messenger.remove(req.params.id, req.params.messageId, user));
  } catch (error) { next(error); }
});

r.post("/:id/messages/:messageId/react", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    res.json(messenger.react(req.params.id, req.params.messageId, user, String(req.body?.emoji || "")));
  } catch (error) { next(error); }
});

r.post("/:id/messages", async (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    const people = directory();
    const conversationId = req.params.id;
    const conversation = messenger.listFor(user.id).find((item) => item.id === conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    const members = people.filter((person) => conversation.memberIds.includes(person.id));
    const text = String(req.body?.text || "");
    const message = messenger.send(conversationId, user, {
      text,
      mentions: parseMentions(text, members),
      attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
      replyToId: String(req.body?.replyToId || ""),
    });
    typing.get(conversationId)?.delete(user.id);
    res.status(201).json(message);

    // Everything below is delivery, not the write itself: the sender already has
    // their answer, and a failing phone or assistant must not fail their message.
    notify(conversation, message, user).catch((error) => console.error(`[messenger] notify failed: ${error.message}`));
    if (shouldMilaAnswer(conversation, message)) {
      answerAsMila(conversation, user).catch((error) => console.error(`[messenger] MILA reply failed: ${error.message}`));
    }
  } catch (error) { next(error); }
});

function previewOf(message) {
  if (message.text) return message.text.slice(0, 300);
  const first = message.attachments[0];
  if (!first) return "";
  return first.kind === "image" ? "📷" : first.kind === "audio" ? "🎤" : `📎 ${first.name}`;
}

async function notify(conversation, message, author) {
  const title = conversation.kind === "channel" ? `${conversation.name} · ${author.name}` : author.name;
  for (const recipient of messenger.recipients(conversation, author.id)) {
    await pushService.sendInbox(recipient, {
      id: message.id,
      title,
      body: previewOf(message),
      priority: message.mentions.includes(recipient) ? "high" : "normal",
      route: `#/chat/${conversation.id}`,
    });
  }
}

async function answerAsMila(conversation, asker) {
  const history = messenger.messages(conversation.id, asker.id, { limit: 24 }).messages;
  let text = "";
  try {
    text = await milaResponder.reply({ conversation, history, asker });
  } catch (error) {
    text = `Не смогла ответить: ${error.message}`;
  }
  if (!text) return;
  const author = { id: MILA_MEMBER_ID, name: "Mila" };
  const message = messenger.send(conversation.id, author, { text, kind: "agent" });
  await notify(conversation, message, author);
}

// Live updates for open conversations. One connection per viewer, and the
// server only sends what that viewer is a member of.
r.get("/stream", (req, res) => {
  const user = authenticatedUser(req);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  online.set(user.id, (online.get(user.id) || 0) + 1);

  const send = (event, payload) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
  };
  const forMembers = (memberIds, event, payload) => {
    if (!memberIds.includes(user.id)) return;
    send(event, payload);
  };
  const onMessage = ({ conversation, message }) => forMembers(conversation.memberIds, "message", { conversationId: conversation.id, message });
  const onUpdated = ({ conversation, message }) => forMembers(conversation.memberIds, "message-updated", { conversationId: conversation.id, message });
  const onConversation = ({ conversation }) => forMembers(conversation.memberIds, "conversation", { conversation });
  const onTyping = ({ conversationId, userId, name, memberIds }) => {
    if (userId === user.id) return;
    forMembers(memberIds, "typing", { conversationId, userId, name });
  };
  const onRead = ({ conversationId, userId, readAt, memberIds }) => forMembers(memberIds, "read", { conversationId, userId, readAt });

  messenger.on("message", onMessage);
  messenger.on("message-updated", onUpdated);
  messenger.on("conversation", onConversation);
  messenger.on("typing", onTyping);
  messenger.on("read", onRead);

  const heartbeat = setInterval(() => send("ping", { at: Date.now() }), 25000);
  heartbeat.unref?.();
  req.on("close", () => {
    clearInterval(heartbeat);
    messenger.off("message", onMessage);
    messenger.off("message-updated", onUpdated);
    messenger.off("conversation", onConversation);
    messenger.off("typing", onTyping);
    messenger.off("read", onRead);
    const left = (online.get(user.id) || 1) - 1;
    if (left > 0) online.set(user.id, left);
    else online.delete(user.id);
  });
});

export default r;
