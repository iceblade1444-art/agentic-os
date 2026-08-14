// The customer-facing Telegram bot: Milana Premium's front desk.
//
// A second bot with a second token, and a hard wall between it and the
// internal assistant. Customers are strangers by definition — no linking, no
// accounts — so this bot must know only what the company chose to publish:
// the knowledge base pages. It never sees the workspace context, the day
// journal, personal profiles or the messenger. Its whole authority is four
// tools: read the knowledge pages three ways, and hand a lead to a manager.
//
// The one writing tool, capture_lead, writes into a store the customer cannot
// read back and notifies the owner through their own inbox — which already
// rides to their personal Telegram. Prices and terms come only from the pages;
// what is not written there is "уточню у менеджера", never an invention. That
// rule is enforced twice: the prompt says it, and the tools make anything else
// impossible.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { knowledgePromptIndex } from "../../assets/js/knowledge-pages.js";

import { config } from "../config.js";
import { db } from "../store.js";
import { creatorUser } from "./auth.js";
import { journal } from "./journal.js";
import { knowledgeBase } from "./knowledge-base.js";
import { milaGeminiChat } from "./mila.js";
import { pushService } from "./push-service.js";
import { hardenRuntimeFile } from "./runtime-files.js";
import { TOOL_PROTOCOL_LINES, runTextToolLoop } from "./text-tool-loop.js";

const API = "https://api.telegram.org";
const CHUNK = 4000;
const HISTORY_TURNS = 10;
const MAX_LEADS = 2000;

const clean = (value, max) => String(value ?? "").trim().slice(0, max);

function customerPrompt(index) {
  return [
    "You are the assistant of Milana Premium — a home and sleepwear manufacturer in Andijan, Uzbekistan: three factories, wholesale-first, exporting to 20+ countries, minimum order one bag.",
    "You are talking to a CUSTOMER in the company's public Telegram bot. Be warm, concise and useful. Answer in the customer's language (Russian, Uzbek or English).",
    "Facts about products, prices, terms and export come ONLY from the company knowledge pages, through your tools. If the answer is not written there, say plainly that a manager will clarify — and offer to take their contact. NEVER invent a price, a fabric, a size or a term.",
    "You know nothing about the company's internal affairs, employees, or other customers, and you never discuss them.",
    "When the customer is interested in ordering — or asks something a manager must answer — collect what they volunteer (name, phone or Telegram, country/city, what and how much) and call capture_lead. Do not interrogate: two or three natural questions at most, and capture what you have. Confirm to the customer that a manager will contact them.",
    "Order status: you cannot look orders up. Take the order number and contact through capture_lead with kind=\"order_status\" and say a manager will reply.",
    `Company knowledge pages:\n${index}`,
    "Your tools: search_company_knowledge {query}, read_company_knowledge {page}, list_company_knowledge {}, capture_lead {name, contact, country, interest, volume, note, kind}.",
    ...TOOL_PROTOCOL_LINES,
  ].join("\n\n");
}

export class SalesBot {
  constructor(options = {}) {
    this.file = options.file || path.join(path.resolve(config.dataDir), "sales-leads.json");
    this.fetch = options.fetch || globalThis.fetch;
    this.integrations = options.integrations || (() => db.integrations.byProvider("salesbot")?.config || {});
    this.chat = options.chat || milaGeminiChat;
    this.milaConfig = options.milaConfig || (() => db.integrations.byProvider("mila")?.config || {});
    this.base = options.knowledgeBase || knowledgeBase;
    this.push = options.pushService || pushService;
    this.journal = options.journal || journal;
    this.creator = options.creatorUser || creatorUser;
    this.history = new Map();
    this.timer = null;
    this.offset = 0;
  }

  token() {
    return clean(this.integrations().botToken || process.env.SALES_BOT_TOKEN, 100);
  }

  configured() {
    return this.token().length > 0;
  }

  // ---------- leads ----------

  #readLeads() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  #writeLeads(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value.slice(-MAX_LEADS), null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
    hardenRuntimeFile(this.file, 0o600);
  }

  leads({ limit = 50 } = {}) {
    return this.#readLeads().slice(-Math.min(Math.max(limit, 1), 200)).reverse();
  }

  setLeadStatus(leadId, status) {
    const allowed = new Set(["new", "contacted", "closed"]);
    if (!allowed.has(status)) throw Object.assign(new Error("Unknown lead status"), { status: 400 });
    const all = this.#readLeads();
    const lead = all.find((item) => item.id === leadId);
    if (!lead) throw Object.assign(new Error("Lead not found"), { status: 404 });
    lead.status = status;
    lead.statusChangedAt = new Date().toISOString();
    this.#writeLeads(all);
    return lead;
  }

  async captureLead(chatMeta, args = {}) {
    const lead = {
      id: `lead_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      kind: clean(args.kind, 40) || "inquiry",
      name: clean(args.name, 120),
      contact: clean(args.contact, 160) || (chatMeta.username ? `@${chatMeta.username}` : ""),
      country: clean(args.country, 80),
      interest: clean(args.interest, 300),
      volume: clean(args.volume, 120),
      note: clean(args.note, 600),
      telegram: { chatId: chatMeta.chatId, username: clean(chatMeta.username, 64) },
      status: "new",
    };
    if (!lead.name && !lead.contact && !lead.interest && !lead.note) {
      throw Object.assign(new Error("An empty lead helps nobody — capture at least a contact or what they asked for"), { status: 400 });
    }
    this.#writeLeads([...this.#readLeads(), lead]);

    // Delivery is best-effort and never blocks the customer conversation: the
    // lead is already stored, and a failed notification must not turn into
    // "the bot broke mid-dialogue".
    const summary = [
      lead.kind === "order_status" ? "Запрос статуса заказа из Telegram" : "Новый лид из Telegram",
      [lead.name, lead.contact, lead.country].filter(Boolean).join(" · "),
      [lead.interest, lead.volume].filter(Boolean).join(" — "),
      lead.note,
    ].filter(Boolean).join("\n");
    this.push
      .sendInbox(this.creator().id, { id: lead.id, title: summary.split("\n")[0], body: summary.split("\n").slice(1).join("\n"), kind: "lead" })
      .catch(() => {});
    Promise.resolve(
      this.journal.append({ actor: "Клиентский бот", kind: "lead", title: summary.split("\n")[0], detail: clean(lead.contact || lead.name, 120) }),
    ).catch(() => {});
    return { ok: true, leadId: lead.id, note: "Lead saved and the manager notified. Tell the customer a manager will contact them." };
  }

  // ---------- conversation ----------

  #remember(chatId, role, content) {
    const turns = this.history.get(chatId) || [];
    turns.push({ role, content: clean(content, 3000) });
    this.history.set(chatId, turns.slice(-HISTORY_TURNS));
  }

  async respond(chatMeta, text) {
    const cfg = this.milaConfig();
    if (!cfg.baseUrl) return "Ассистент сейчас недоступен — напишите нам позже, пожалуйста.";
    // The customer prompt is built from the public pages and nothing else:
    // no sharedAgentContext, no journal, no profiles — by construction.
    const systemPrompt = customerPrompt(knowledgePromptIndex());
    this.#remember(chatMeta.chatId, "user", text);

    const scope = { actor: "sales-bot", source: "sales-bot" };
    const { text: reply } = await runTextToolLoop({
      chat: this.chat,
      cfg,
      label: "Sales bot",
      systemPrompt,
      messages: [...(this.history.get(chatMeta.chatId) || [])],
      fallback: "Простите, я запуталась. Напишите, пожалуйста, ещё раз — или оставьте контакт, и менеджер свяжется с вами.",
      execute: async (name, args) => {
        // The whole authority of this bot, enumerated. Anything else — personal
        // actions, ERP, vault — simply does not exist on this side of the wall.
        if (name === "search_company_knowledge") return { matches: await this.base.search(clean(args.query, 200), scope) };
        if (name === "read_company_knowledge") return this.base.read(clean(args.page, 80), scope);
        if (name === "list_company_knowledge") return { pages: await this.base.list(scope) };
        if (name === "capture_lead") return this.captureLead(chatMeta, args);
        return { ok: false, error: `Unknown tool "${name}"` };
      },
    });
    this.#remember(chatMeta.chatId, "assistant", reply);
    return reply;
  }

  // ---------- telegram plumbing ----------

  start() {
    if (this.timer) return;
    const tick = async () => {
      try {
        if (this.configured()) await this.#poll();
      } catch (error) {
        console.warn(`[sales-bot] poll failed: ${error.message}`);
      } finally {
        this.timer = setTimeout(tick, 3000);
      }
    };
    this.timer = setTimeout(tick, 3000);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  async #poll() {
    const updates = await this.#call("getUpdates", { offset: this.offset, timeout: 20 }, 25000);
    for (const update of updates || []) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      await this.handleUpdateForTest(update).catch((error) => console.warn(`[sales-bot] update failed: ${error.message}`));
    }
  }

  async handleUpdateForTest(update) {
    const message = update.message;
    const chatId = message?.chat?.id;
    const text = clean(message?.text, 4000);
    if (!chatId || !text) return;
    const chatMeta = { chatId, username: clean(message.from?.username, 64) };

    if (text.startsWith("/start")) {
      await this.#call("sendMessage", {
        chat_id: chatId,
        text: "Здравствуйте! Это ассистент Milana Premium — домашняя одежда и пижамы оптом из Узбекистана. Спросите про ассортимент, оптовые условия или экспорт — отвечу и передам менеджеру, если нужно. Yozing — o‘zbek tilida ham javob beraman. You can also write in English.",
      });
      return;
    }

    await this.#call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    const reply = await this.respond(chatMeta, text);
    for (let start = 0; start < reply.length; start += CHUNK) {
      await this.#call("sendMessage", { chat_id: chatId, text: reply.slice(start, start + CHUNK) });
    }
  }

  async #call(method, body = undefined, timeoutMs = 9000) {
    const token = this.token();
    if (!token) throw new Error("no bot token");
    const response = await this.fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await response.json().catch(() => ({}));
    if (!json.ok) throw new Error(clean(json.description, 200) || `telegram ${method} HTTP ${response.status}`);
    return json.result;
  }
}

export const salesBot = new SalesBot();
