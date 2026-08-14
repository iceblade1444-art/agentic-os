// MILA delivering to personal Telegram accounts, through one company bot.
//
// The model is consent-first, and most of it is enforced by Telegram itself: a
// bot cannot write to a person who never started it. Each employee links their
// own account by opening t.me/<bot>?start=<one-time code> — the code is issued
// to their signed-in session, so the chat that sends it back is provably theirs.
// The bridge then knows exactly one chat per account, always the owner's own.
//
// Nothing here accepts an arbitrary chat id. Sending is by user id, resolved
// through the link that user created, which is what keeps "пришли в телеграм"
// from ever becoming a way to message someone who did not ask.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { db } from "../store.js";
import { hardenRuntimeFile } from "./runtime-files.js";

const API = "https://api.telegram.org";
const CODE_TTL_MS = 15 * 60 * 1000;
// Telegram caps a message at 4096 characters; long content is sent as parts
// rather than truncated, because "любые данные" that arrive cut off are not
// the data.
const CHUNK = 4000;

const clean = (value, max) => String(value ?? "").trim().slice(0, max);

export class TelegramBridge {
  constructor(options = {}) {
    this.file = options.file || path.join(path.resolve(config.dataDir), "telegram-links.json");
    this.fetch = options.fetch || globalThis.fetch;
    this.integrations = options.integrations || (() => db.integrations.byProvider("telegram")?.config || {});
    // code -> { userId, expiresAt }; issued codes live in memory on purpose:
    // a restart invalidates them and the person just taps the button again.
    this.pending = new Map();
    // Injected at startup rather than imported: the assistant pulls in
    // mila-actions, which imports this module for send_telegram — a cycle ESM
    // would technically survive but nobody should have to reason about.
    this.assistant = options.assistant || null;
    this.timer = null;
    this.offset = 0;
    this.botName = "";
  }

  token() {
    return clean(this.integrations().botToken || process.env.TELEGRAM_BOT_TOKEN, 100);
  }

  configured() {
    return this.token().length > 0;
  }

  // ---------- link storage ----------

  #read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  #write(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
    hardenRuntimeFile(this.file, 0o600);
  }

  link(userId) {
    const entry = this.#read()[userId];
    return entry?.chatId ? { linked: true, username: entry.username || "", linkedAt: entry.linkedAt || "" } : { linked: false };
  }

  unlink(userId) {
    const all = this.#read();
    if (!Object.hasOwn(all, userId)) return false;
    delete all[userId];
    this.#write(all);
    return true;
  }

  // The account is gone; the bridge to its Telegram goes with it, or deleted
  // users would keep receiving company notifications forever.
  removeUser(userId) {
    return this.unlink(userId);
  }

  // ---------- linking flow ----------

  async issueLinkCode(user) {
    if (!this.configured()) {
      throw Object.assign(new Error("Telegram bot is not configured"), { status: 503 });
    }
    for (const [code, value] of this.pending) {
      if (value.expiresAt <= Date.now() || value.userId === user.id) this.pending.delete(code);
    }
    const code = crypto.randomBytes(12).toString("base64url");
    this.pending.set(code, { userId: user.id, expiresAt: Date.now() + CODE_TTL_MS });
    if (!this.botName) {
      const me = await this.#call("getMe");
      this.botName = clean(me?.username, 64);
    }
    return { url: `https://t.me/${this.botName}?start=${code}`, expiresInSeconds: CODE_TTL_MS / 1000 };
  }

  #consumeCode(code) {
    const value = this.pending.get(code);
    this.pending.delete(code);
    if (!value || value.expiresAt <= Date.now()) return null;
    return value.userId;
  }

  // ---------- sending ----------

  /// Sends to this user's own linked chat and to nowhere else. Returns false
  /// when there is no link, so callers can treat Telegram as optional delivery.
  async sendText(userId, text) {
    const entry = this.#read()[userId];
    if (!entry?.chatId || !this.configured()) return false;
    const body = clean(text, 60000);
    if (!body) return false;
    for (let start = 0; start < body.length; start += CHUNK) {
      await this.#call("sendMessage", {
        chat_id: entry.chatId,
        text: body.slice(start, start + CHUNK),
      });
    }
    return true;
  }

  // ---------- receiving ----------

  // Long polling instead of a webhook: nothing inbound to expose, nothing to
  // misconfigure on the proxy, and one bot polling is well within limits.
  start() {
    if (this.timer) return;
    const tick = async () => {
      try {
        if (this.configured()) await this.#poll();
      } catch (error) {
        console.warn(`[telegram] poll failed: ${error.message}`);
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
      await this.handleUpdateForTest(update).catch((error) => console.warn(`[telegram] update failed: ${error.message}`));
    }
  }

  // Public: the poller calls it per update, and tests drive it directly —
  // simulating the person tapping Start is the only honest way to test linking.
  async handleUpdateForTest(update) {
    const message = update.message;
    const chatId = message?.chat?.id;
    // Commands are short; a real question to MILA is not. 4000 matches one
    // Telegram message, so nothing a person can type in one go is cut.
    const text = clean(message?.text, 4000);
    if (!chatId || !text) return;

    if (text.startsWith("/start")) {
      const code = clean(text.split(/\s+/)[1], 64);
      const userId = code ? this.#consumeCode(code) : null;
      if (!userId) {
        await this.#call("sendMessage", {
          chat_id: chatId,
          text: "Эта ссылка устарела. Откройте Agentic OS → Персональное → Telegram и нажмите «Привязать» ещё раз.",
        });
        return;
      }
      const all = this.#read();
      // One chat per account and one account per chat: linking again from a
      // new Telegram replaces the old link instead of accumulating audiences.
      for (const [existing, value] of Object.entries(all)) {
        if (value.chatId === chatId && existing !== userId) delete all[existing];
      }
      all[userId] = {
        chatId,
        username: clean(message.from?.username, 64),
        linkedAt: new Date().toISOString(),
      };
      this.#write(all);
      await this.#call("sendMessage", {
        chat_id: chatId,
        text: "Готово — Telegram привязан. MILA сможет присылать сюда напоминания, утренний бриф и всё, что вы попросите переслать. Отвязать: /stop",
      });
      return;
    }

    if (text.startsWith("/stop")) {
      const all = this.#read();
      const entry = Object.entries(all).find(([, value]) => value.chatId === chatId);
      if (entry) {
        delete all[entry[0]];
        this.#write(all);
      }
      await this.#call("sendMessage", { chat_id: chatId, text: "Отвязано. Привязать заново можно из Agentic OS." });
      return;
    }

    // A linked chat is authenticated by construction — the link exists only
    // because its owner created it from their signed-in session — so MILA may
    // answer here with that person's own context, exactly as in a direct
    // thread. An unlinked chat stays a stranger and gets the pointer.
    const link = Object.entries(this.#read()).find(([, value]) => value.chatId === chatId);
    if (link && this.assistant) {
      await this.#call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      const reply = await this.assistant.respond(link[0], text);
      if (reply) {
        for (let start = 0; start < reply.length; start += CHUNK) {
          await this.#call("sendMessage", { chat_id: chatId, text: reply.slice(start, start + CHUNK) });
        }
        return;
      }
      // The account behind the link is gone or disabled: drop the orphan link
      // rather than keep a dead man's chat half-alive.
      this.unlink(link[0]);
    }
    await this.#call("sendMessage", {
      chat_id: chatId,
      text: "Я отвечаю только привязанным сотрудникам. Откройте Agentic OS → Персональное → Telegram и нажмите «Привязать». Команды: /stop — отвязать.",
    });
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

export const telegram = new TelegramBridge();
