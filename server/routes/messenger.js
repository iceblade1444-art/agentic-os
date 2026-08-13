import { Router } from "express";

import { authenticatedUser, creatorUser } from "../lib/auth.js";
import { messenger, parseMentions, MILA_MEMBER_ID } from "../lib/messenger.js";
import { milaResponder, shouldMilaAnswer } from "../lib/messenger-mila.js";
import { pushService } from "../lib/push-service.js";
import { users } from "../lib/users.js";

const r = Router();

const MILA_MEMBER = { id: MILA_MEMBER_ID, name: "Mila", handle: "mila", role: "Assistant", kind: "agent" };

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
    }));
  return [...people, MILA_MEMBER];
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
      conversations: messenger.listFor(user.id).map((conversation) => decorate(conversation, user.id, people)),
    });
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
    res.json(messenger.messages(req.params.id, user.id, { limit: req.query.limit, before: req.query.before }));
  } catch (error) { next(error); }
});

r.post("/:id/read", (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    res.json(messenger.markRead(user.id, req.params.id));
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
    const message = messenger.send(conversationId, user, { text, mentions: parseMentions(text, members) });
    res.status(201).json(message);

    // Everything below is delivery, not the write itself: the sender already has
    // their answer, and a failing phone or assistant must not fail their message.
    notify(conversation, message, user, people).catch((error) => console.error(`[messenger] notify failed: ${error.message}`));
    if (shouldMilaAnswer(conversation, message)) {
      answerAsMila(conversation, user, people).catch((error) => console.error(`[messenger] MILA reply failed: ${error.message}`));
    }
  } catch (error) { next(error); }
});

async function notify(conversation, message, author, people) {
  const title = conversation.kind === "channel"
    ? `${conversation.name} · ${author.name}`
    : author.name;
  for (const recipient of messenger.recipients(conversation, author.id)) {
    await pushService.sendInbox(recipient, {
      id: message.id,
      title,
      body: message.text.slice(0, 300),
      priority: message.mentions.includes(recipient) ? "high" : "normal",
      route: `#/chat/${conversation.id}`,
    });
  }
}

async function answerAsMila(conversation, asker, people) {
  const history = messenger.messages(conversation.id, asker.id, { limit: 24 }).messages;
  let text = "";
  try {
    text = await milaResponder.reply({ conversation, history, asker });
  } catch (error) {
    text = `Не смогла ответить: ${error.message}`;
  }
  if (!text) return;
  const message = messenger.send(conversation.id, { id: MILA_MEMBER_ID, name: "Mila" }, { text, kind: "agent" });
  await notify(conversation, message, { id: MILA_MEMBER_ID, name: "Mila" }, people);
}

// Live updates for open conversations. One connection per viewer, and the
// server only sends what that viewer is a member of.
r.get("/stream", (req, res) => {
  const user = authenticatedUser(req);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();

  const send = (event, payload) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
  };
  const onMessage = ({ conversation, message }) => {
    if (!conversation.memberIds.includes(user.id)) return;
    send("message", { conversationId: conversation.id, message });
  };
  const onConversation = ({ conversation }) => {
    if (!conversation.memberIds.includes(user.id)) return;
    send("conversation", { conversation });
  };
  messenger.on("message", onMessage);
  messenger.on("conversation", onConversation);

  const heartbeat = setInterval(() => send("ping", { at: Date.now() }), 25000);
  heartbeat.unref?.();
  req.on("close", () => {
    clearInterval(heartbeat);
    messenger.off("message", onMessage);
    messenger.off("conversation", onConversation);
  });
});

export default r;
