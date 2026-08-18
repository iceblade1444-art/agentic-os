// MILA answering in a linked personal Telegram chat.
//
// The link IS the authentication: a chat id appears in telegram-links.json only
// because its owner opened a one-time deep link issued to their signed-in
// session. So an incoming message from a linked chat is as much "them" as a
// request carrying their session cookie, and MILA may answer with their own
// personal context — the same audience rule as a direct thread, never a room.
//
// The Gemini proxy on the MILA backend is text-in, text-out: no native function
// calling. Tools work over a text protocol instead — the model replies with a
// single TOOL_CALL line, Agentic OS executes it and feeds a TOOL_RESULT message
// back, and the loop continues until she answers in prose. The gate is the same
// one the phone lives behind: personal actions, read-only knowledge, read-only
// ERP. Nothing operator-grade is reachable from a Telegram message.

import { buildMilaSystemInstruction } from "../../assets/js/mila-prompt.js";
import { TOOL_PROTOCOL_LINES, runTextToolLoop } from "./text-tool-loop.js";
import { knowledgePromptIndex } from "../../assets/js/knowledge-pages.js";

import { db } from "../store.js";
import { creatorUser } from "./auth.js";
import { KNOWLEDGE_ACTIONS, PERSONAL_ACTIONS, milaActions } from "./mila-actions.js";
import { milaGeminiChat } from "./mila.js";
import { sharedAgentContext } from "./onboarding.js";
import { users } from "./users.js";

const HISTORY_TURNS = 12;
const MAX_TOOL_STEPS = 4;
const READ_ONLY_ERP = new Set(["get_erp_business_context", "get_finished_goods_stock", "get_sewing_daily_report"]);
// The same set a Member's phone may call — a Telegram message must never reach
// further than the app in that person's hand.
const allowed = (name, user) => PERSONAL_ACTIONS.has(name) || KNOWLEDGE_ACTIONS.has(name) || READ_ONLY_ERP.has(name)
  || (isOperator(user) && OPERATOR_TOOLS.includes(name));

const TOOL_NAMES = [
  "get_my_day_plan", "list_my_tasks", "create_my_task", "update_my_task",
  "list_my_notes", "save_my_note", "remind_me", "list_my_reminders", "cancel_reminder",
  "list_my_calendar", "remember_about_me", "read_about_me", "forget_about_me",
  "search_company_knowledge", "read_company_knowledge", "list_company_knowledge",
  "get_erp_business_context", "get_finished_goods_stock", "get_sewing_daily_report",
];
// Staff data — the turnstile and the employee directory — follows the person,
// not the channel: an operator keeps it in their own linked chat, a Member
// does not get it anywhere.
const OPERATOR_TOOLS = ["get_attendance_today", "get_staff_summary"];
const isOperator = (user) => ["Creator", "Admin"].includes(user?.role);

const clean = (value, max) => String(value ?? "").trim().slice(0, max);

// The one Telegram-specific paragraph. Everything else — identity, personal
// desk rules, knowledge rules, profile rules — comes from the shared prompt, so
// Telegram-MILA and app-MILA cannot drift apart.
function toolProtocol() {
  return [
    "You are answering inside the owner's personal Telegram chat with you. Keep replies short and chat-shaped; no markdown headers.",
    "Function calling is not available on this channel. To use one of your tools, reply with EXACTLY one line and nothing else:",
    'TOOL_CALL {"name":"remind_me","args":{"title":"...","dueAt":"..."}}',
    "The system will execute it and send you the result as a message starting with TOOL_RESULT. Then answer the person in plain prose.",
    "Never write TOOL_RESULT yourself, never claim an action happened without a TOOL_RESULT proving it, and never put a TOOL_CALL and prose in the same reply.",
    "A tool that failed earlier in this chat is not broken now: deploys restart things. When asked again, always try the TOOL_CALL fresh instead of repeating an old apology.",
  ].join("\n");
}

export function createTelegramAssistant(options = {}) {
  const chat = options.chat || milaGeminiChat;
  const actions = options.actions || milaActions;
  const context = options.sharedAgentContext || sharedAgentContext;
  const store = options.db || db;
  const userStore = options.users || users;
  const creator = options.creatorUser || creatorUser;
  // Short-lived, in memory on purpose: a Telegram thread is a running
  // conversation, not an archive — the durable record of anything that matters
  // is the action it triggered. A restart simply starts a fresh exchange.
  const history = new Map();

  function resolveUser(userId) {
    if (userId === "creator") return creator();
    const user = userStore.get(userId);
    return user && !user.disabledAt ? user : null;
  }

  function remember(userId, role, content) {
    const turns = history.get(userId) || [];
    turns.push({ role, content: clean(content, 4000) });
    history.set(userId, turns.slice(-HISTORY_TURNS));
  }

  async function respond(userId, text) {
    const user = resolveUser(userId);
    if (!user) return null;
    const cfg = store.integrations.byProvider("mila")?.config || {};
    if (!cfg.baseUrl) {
      return "MILA сейчас не подключена к серверу — попробуйте позже или откройте приложение.";
    }

    const systemPrompt = [
      buildMilaSystemInstruction({
        language: "auto",
        preferences: { userName: clean(user.name, 40) || "Владелец" },
        // Their own chat, so their own context — profile and journal included,
        // exactly as in a direct thread.
        agentContext: context(user),
        mode: "text",
        tools: isOperator(user) ? [...TOOL_NAMES, ...OPERATOR_TOOLS] : TOOL_NAMES,
        knowledgeIndex: knowledgePromptIndex(),
      }),
      toolProtocol(),
    ].join("\n\n");

    remember(user.id, "user", text);

    const { text: reply } = await runTextToolLoop({
      chat,
      cfg,
      label: "Telegram assistant",
      systemPrompt,
      messages: [...(history.get(user.id) || [])],
      fallback: "Я запуталась в шагах — попробуйте попросить ещё раз, попроще.",
      execute: async (name, args) => {
        if (!allowed(name, user)) {
          return { ok: false, error: `Tool "${name}" is not available in Telegram.` };
        }
        return actions.call(name, args, { actor: user.name, user });
      },
    });
    if (reply && !reply.startsWith("Я запуталась")) {
      remember(user.id, "assistant", reply);
      return reply;
    }
    return "Я запуталась в шагах — попробуйте попросить ещё раз, попроще.";
  }

  return { respond, historySize: () => history.size };
}

export const telegramAssistant = createTelegramAssistant();
