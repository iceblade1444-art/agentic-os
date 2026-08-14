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
import { knowledgePromptIndex } from "../../assets/js/knowledge-pages.js";

import { db } from "../store.js";
import { MILA_MEMBER_ID } from "./messenger.js";
import { KNOWLEDGE_ACTIONS, PERSONAL_ACTIONS, milaActions } from "./mila-actions.js";
import { milaGeminiChat } from "./mila.js";
import { sharedAgentContext } from "./onboarding.js";
import { TOOL_PROTOCOL_LINES, runTextToolLoop } from "./text-tool-loop.js";

// What she may reach from a chat message depends on who reads the answer.
// Company data — knowledge pages and the read-only ERP trio — is fine in a
// channel: every member could run the same query themselves. The personal desk
// exists only in a direct thread, because "напомни мне" from a channel would
// still be one person's desk, but the confirmation of it would be a message
// the whole room reads.
const ERP_READ = ["get_erp_business_context", "get_finished_goods_stock", "get_sewing_daily_report"];
const KNOWLEDGE = ["search_company_knowledge", "read_company_knowledge", "list_company_knowledge"];
const PERSONAL = [
  "get_my_day_plan", "list_my_tasks", "create_my_task", "update_my_task",
  "list_my_notes", "save_my_note", "remind_me", "list_my_reminders", "cancel_reminder",
  "list_my_calendar", "remember_about_me", "read_about_me", "forget_about_me", "send_telegram",
];

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

    const inChannel = conversation.kind === "channel";
    const toolNames = inChannel ? [...KNOWLEDGE, ...ERP_READ] : [...PERSONAL, ...KNOWLEDGE, ...ERP_READ];
    const allowed = (name) => toolNames.includes(name)
      && (PERSONAL_ACTIONS.has(name) || KNOWLEDGE_ACTIONS.has(name) || ERP_READ.includes(name));
    const where = inChannel
      ? `You are writing in the team channel "${clean(conversation.name, 80)}" of the corporate chat. Several colleagues read it.`
      : "You are writing in a private chat with one colleague.";
    const systemPrompt = [
      buildMilaSystemInstruction({
        language: "auto",
        preferences: { userName: clean(asker?.name, 40) || "Коллега" },
        // In a channel her reply is a message several colleagues read, so she is
        // given the workspace but not the asker's private profile and not the
        // day journal — a group room is not the place to be holding either. A
        // direct thread is between her and one person, so it keeps them.
        agentContext: context(asker || { id: "system", role: "Creator" }, undefined, {
          audience: inChannel ? "shared" : "owner",
        }),
        mode: "text",
        tools: toolNames,
        knowledgeIndex: knowledgePromptIndex(),
      }),
      `${where} Answer the person who addressed you, keep it short enough to read on a phone, and never invent facts about the company: if you do not know, say so and say who could.`,
      TOOL_PROTOCOL_LINES.join("\n"),
    ].join("\n\n");

    const executor = options.actions || milaActions;
    const { text } = await runTextToolLoop({
      chat,
      cfg,
      label: "Agentic OS corporate chat",
      systemPrompt,
      messages: transcript(history, conversation),
      fallback: "Я запуталась в шагах — спросите ещё раз, попроще.",
      execute: async (name, args) => {
        if (!allowed(name)) {
          return { ok: false, error: inChannel
            ? `Tool "${name}" is not available in a channel — personal actions live in a direct chat with MILA.`
            : `Tool "${name}" is not available in chat.` };
        }
        return executor.call(name, args, { actor: clean(asker?.name, 60) || "Коллега", user: asker });
      },
    });
    return clean(text, 4000);
  }

  return { reply };
}

export const milaResponder = createMilaResponder();
