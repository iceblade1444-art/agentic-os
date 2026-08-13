// MILA as a colleague in the corporate chat.
//
// She answers only when addressed — a mention in a channel, or any message in a
// direct thread with her. An assistant that replies to everything turns a team
// channel into a monologue, and people stop writing there.
//
// She answers with the same composed prompt the rest of the product uses, plus
// the workspace context and day journal, so what she says in a channel matches
// what she says on the phone.

import { buildMilaSystemInstruction } from "../../assets/js/mila-prompt.js";

import { db } from "../store.js";
import { MILA_MEMBER_ID } from "./messenger.js";
import { milaGeminiChat } from "./mila.js";
import { sharedAgentContext } from "./onboarding.js";

const HISTORY_TURNS = 12;
const clean = (value, max) => String(value ?? "").trim().slice(0, max);

export function shouldMilaAnswer(conversation, message) {
  if (message.authorId === MILA_MEMBER_ID) return false;
  if (message.kind !== "user") return false;
  if (!conversation.memberIds.includes(MILA_MEMBER_ID)) return false;
  if (conversation.kind === "direct") return true;
  return message.mentions.includes(MILA_MEMBER_ID);
}

export function createMilaResponder(options = {}) {
  const store = options.db || db;
  const chat = options.chat || milaGeminiChat;
  const context = options.sharedAgentContext || sharedAgentContext;

  // A channel is a group conversation, so the transcript is labelled by author:
  // without names she cannot tell who asked what and answers the wrong person.
  function transcript(history, conversation) {
    return history.slice(-HISTORY_TURNS).map((message) => ({
      role: message.authorId === MILA_MEMBER_ID ? "assistant" : "user",
      content: message.authorId === MILA_MEMBER_ID
        ? clean(message.text, 4000)
        : `${clean(message.authorName, 80)}${conversation.kind === "channel" ? "" : ""}: ${clean(message.text, 4000)}`,
    }));
  }

  async function reply({ conversation, history, asker }) {
    const cfg = store.integrations.byProvider("mila")?.config || {};
    if (!cfg.baseUrl) throw Object.assign(new Error("MILA backend is not configured"), { status: 503 });

    const where = conversation.kind === "channel"
      ? `You are writing in the team channel "${clean(conversation.name, 80)}" of the corporate chat. Several colleagues read it.`
      : "You are writing in a private chat with one colleague.";
    const systemPrompt = [
      buildMilaSystemInstruction({
        language: "auto",
        preferences: { userName: clean(asker?.name, 40) || "Коллега" },
        agentContext: context(asker || { id: "system", role: "Creator" }),
        mode: "text",
        // In a chat thread she can only write; the personal desk and ERP tools
        // live on surfaces that can actually call them.
        tools: [],
      }),
      `${where} Answer the person who addressed you, keep it short enough to read on a phone, and never invent facts about the company: if you do not know, say so and say who could.`,
    ].join("\n\n");

    const result = await chat(cfg, "Agentic OS corporate chat", {
      messages: transcript(history, conversation),
      systemPrompt,
    });
    return clean(result?.text, 4000);
  }

  return { reply };
}

export const milaResponder = createMilaResponder();
