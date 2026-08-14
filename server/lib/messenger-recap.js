// "Что я пропустил" — a recap of a conversation the reader fell behind on.
//
// Membership is checked by the same call that fetches the messages, so a recap
// can never summarize a room the caller cannot open. The summary is built for
// the person asking: their own messages are labelled as theirs, and the model
// is told to surface what needs an answer from them — a recap that buries a
// direct question is worse than scrolling.

import { db } from "../store.js";
import { messenger } from "./messenger.js";
import { milaGeminiChat } from "./mila.js";

const MAX_MESSAGES = 120;
const clean = (value, max) => String(value ?? "").trim().slice(0, max);

const RECAP_PROMPT = [
  "You summarize a missed stretch of a work chat for one participant. Write in the language the chat is in.",
  "Shape: 2-6 short bullet lines, then — only if something is addressed to the reader or waits on them — a final line starting with «Ждут от вас:».",
  "Only what is actually in the messages: no invented decisions, no guessed tone. Names stay names. Skip pleasantries.",
].join("\n");

export function createMessengerRecap(options = {}) {
  const store = options.messenger || messenger;
  const chat = options.chat || milaGeminiChat;
  const milaConfig = options.milaConfig || (() => db.integrations.byProvider("mila")?.config || {});

  async function recap(user, conversationId) {
    const cfg = milaConfig();
    if (!cfg.baseUrl) throw Object.assign(new Error("MILA backend is not configured"), { status: 503 });

    // Membership gate and data in one call: a non-member gets the same 403 the
    // messenger itself gives, before any model sees anything.
    const { messages } = store.messages(conversationId, user.id, { limit: MAX_MESSAGES });
    const conversation = store.listFor(user.id).find((item) => item.id === conversationId);
    const readAt = conversation?.firstUnreadAt || "";

    // Unread if there is unread; otherwise the recent tail — "напомни, о чём
    // тут" is a legitimate ask even in a caught-up thread.
    const missed = readAt ? messages.filter((message) => message.createdAt >= readAt) : messages.slice(-40);
    const meaningful = missed.filter((message) => !message.deleted && message.text);
    if (meaningful.length < 3) {
      return { recap: "", note: "Пересказывать нечего — новых сообщений почти нет.", covered: meaningful.length };
    }

    const transcript = meaningful
      .map((message) => `${message.authorId === user.id ? `${message.authorName} (это вы)` : message.authorName}: ${clean(message.text, 500)}`)
      .join("\n");
    const result = await chat(cfg, "Chat recap", {
      messages: [{ role: "user", content: transcript }],
      systemPrompt: `${RECAP_PROMPT}\nThe reader is ${clean(user.name, 60)}.`,
    });
    const text = clean(result?.text, 3000);
    if (!text) throw Object.assign(new Error("MILA could not build the recap"), { status: 502 });
    return { recap: text, covered: meaningful.length, since: readAt || meaningful[0]?.createdAt || "" };
  }

  return { recap };
}

export const messengerRecap = createMessengerRecap();
