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
import { tIn } from "../../assets/js/i18n.js";
import { creatorUser } from "./auth.js";
import { memberWorkspaces } from "./member-workspace.js";
import { onboarding } from "./onboarding.js";
import { hardenRuntimeFile } from "./runtime-files.js";
import {
  ASSISTANT_COMMANDS, buildCard, commandList, parseCallback,
} from "./telegram-cards.js";
import { audioFileId, speaker, voiceTranscriber } from "./telegram-voice.js";
import { users } from "./users.js";

const API = "https://api.telegram.org";
const CODE_TTL_MS = 15 * 60 * 1000;
// Telegram caps a message at 4096 characters; long content is sent as parts
// rather than truncated, because "любые данные" that arrive cut off are not
// the data.
const CHUNK = 4000;

const clean = (value, max) => String(value ?? "").trim().slice(0, max);

// Every text message carries an offer to hear it. Reading is the default —
// text can be searched, quoted and skimmed — but a person walking the floor
// with a phone in their pocket can tap once instead of stopping to read.
//
// The callback carries no payload: Telegram limits callback_data to 64 bytes,
// which cannot hold a brief, and it hands the original message back with the
// button press anyway. So the text to speak is read from the message the
// button sits under, and nothing has to be stored between the two events.
const SPEAK_CALLBACK = "speak";
const speakButton = (locale = "ru-RU") => ({
  inline_keyboard: [[{ text: `🔊 ${tIn(locale, "telegram.act.listen")}`, callback_data: SPEAK_CALLBACK }]],
});

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
    this.voice = options.voice || voiceTranscriber;
    this.speaker = options.speaker || speaker;
    // Snoozing creates a reminder, and reminders.js imports push-service.js,
    // which imports this file. Injected for the same reason the assistant is:
    // the cycle is real, not hypothetical.
    this.reminders = options.reminders || null;
    this.workspaces = options.workspaces || memberWorkspaces;
    this.users = options.users || users;
    this.creatorUser = options.creatorUser || creatorUser;
    this.onboarding = options.onboarding || onboarding;
    this.publicUrl = options.publicUrl || (() => config.publicUrl);
    this.timer = null;
    this.offset = 0;
    this.botName = "";
  }

  // The reader's own language, for a message nobody asked for. Falls back to
  // Russian, which is what the factory floor reads.
  localeFor(userId) {
    try {
      const user = this.#user(userId);
      return user ? this.onboarding.get(user).profile?.locale || "ru-RU" : "ru-RU";
    } catch {
      return "ru-RU";
    }
  }

  #user(userId) {
    if (userId === "creator") return this.creatorUser();
    const user = this.users.get(userId);
    return user && !user.disabledAt ? user : null;
  }

  #userIdForChat(chatId) {
    const found = Object.entries(this.#read()).find(([, value]) => value.chatId === chatId);
    return found ? found[0] : null;
  }

  /// Which account, if any, this Telegram chat belongs to.
  ///
  /// Public because the Mini App needs it: Telegram proves who is asking, and
  /// this is the only thing that says whether that person is anybody here. For
  /// a private chat the chat id and the user id are the same number, which is
  /// what makes a bot link usable as a Mini App credential.
  ///
  /// Read-only and one-directional on purpose — it answers "whose chat is
  /// this", never "what is so-and-so's chat".
  accountForChat(chatId) {
    const id = Number(chatId);
    return Number.isSafeInteger(id) ? this.#userIdForChat(id) : null;
  }

  // For someone we already know, their profile. For a stranger — the expired
  // link, the wrong chat — Telegram's own language_code is the only signal
  // there is, and it beats answering everyone in Russian.
  #chatLocale(chatId, from = null) {
    const userId = this.#userIdForChat(chatId);
    if (userId) return this.localeFor(userId);
    const declared = String(from?.language_code || "").toLowerCase();
    if (declared.startsWith("uz")) return "uz-UZ";
    if (declared.startsWith("en")) return "en-US";
    return "ru-RU";
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
        reply_markup: speakButton(this.localeFor(userId)),
      });
    }
    return true;
  }

  /// A notification, as the thing it actually is.
  ///
  /// Everything that reaches a person here is one of a handful of objects — a
  /// reminder, a task, a calendar alert, a colleague's message, an ERP anomaly —
  /// and each supports different verbs. The card carries those verbs as buttons
  /// so the common case never needs the app: mark it done, push it an hour,
  /// clear it, open it.
  ///
  /// Falls back to plain text when the item has no shape worth formatting, and
  /// returns false when there is no link, exactly like sendText.
  async sendCard(userId, item) {
    const entry = this.#read()[userId];
    if (!entry?.chatId || !this.configured()) return false;
    const card = buildCard(item, {
      locale: this.localeFor(userId),
      publicUrl: typeof this.publicUrl === "function" ? this.publicUrl() : this.publicUrl,
    });
    if (!card) return false;
    // A card longer than one Telegram message is a card that should have been a
    // link. Send the head with its buttons, then the rest as plain continuation
    // so nothing is lost and the buttons stay attached to the top.
    const head = card.text.slice(0, CHUNK);
    await this.#call("sendMessage", {
      chat_id: entry.chatId,
      text: head,
      parse_mode: card.parseMode,
      reply_markup: card.keyboard,
    });
    for (let start = CHUNK; start < card.text.length; start += CHUNK) {
      await this.#call("sendMessage", {
        chat_id: entry.chatId,
        text: card.text.slice(start, start + CHUNK),
        parse_mode: card.parseMode,
      });
    }
    // Only what asked to be read aloud, and only after the text is already
    // there. A speech service that is down costs the voice, not the brief.
    if (item?.speak === true) {
      try {
        const audio = await this.speaker.speak([item.title, item.body].filter(Boolean).join("\n"));
        if (audio) await this.#sendVoice(entry.chatId, audio);
      } catch (error) {
        console.warn(`[telegram] could not speak for ${userId}: ${error.message}`);
      }
    }
    return true;
  }

  /// The morning brief, read out. Text first and always — a voice message
  /// cannot be searched, forwarded as a quote, or read during a meeting — and
  /// the audio is an addition for the people who asked for it, never a
  /// replacement. A speech service that is down costs the voice, not the brief.
  async sendSpoken(userId, text) {
    const sent = await this.sendText(userId, text);
    if (!sent) return false;
    const entry = this.#read()[userId];
    try {
      const audio = await this.speaker.speak(text);
      if (audio) {
        await this.#sendVoice(entry.chatId, audio);
        return true;
      }
    } catch (error) {
      console.warn(`[telegram] could not speak for ${userId}: ${error.message}`);
    }
    return false;
  }

  // ---------- receiving ----------

  // Long polling instead of a webhook: nothing inbound to expose, nothing to
  // misconfigure on the proxy, and one bot polling is well within limits.
  // The "/" menu belongs to the token, not to this process: the bot that held
  // this token before still had its own commands published — /models,
  // /new_session — offering people a menu that does nothing here. Publishing
  // ours at startup replaces that inheritance instead of waiting for someone
  // to request a link.
  // Six commands, in each language the app speaks. Telegram keeps one list per
  // language_code and falls back to the unqualified one, so publishing all
  // three means the menu is readable whatever the person set their client to —
  // the two commands that were here before were Russian for everybody.
  async publishCommands() {
    if (!this.configured()) return false;
    await this.#call("setMyCommands", { commands: commandList("ru-RU") });
    for (const [locale, code] of [["en-US", "en"], ["uz-UZ", "uz"]]) {
      await this.#call("setMyCommands", { commands: commandList(locale), language_code: code })
        .catch((error) => console.warn(`[telegram] commands for ${code}: ${error.message}`));
    }
    // The composer gets a button straight into the app instead of only ever
    // offering "/".
    //
    // Just the product name. Telegram gives this button a fixed strip beside
    // the message field, and "Открыть Agentic OS" pushed the field into a
    // sliver on a phone. A name is what a person needs there; the verb is
    // already carried by the button being a button.
    //
    // Unlike setMyCommands this is published once rather than per language,
    // which used to mean an English chat got the Russian wording. A product
    // name is the same in all three, so the question stops arising.
    const base = String(typeof this.publicUrl === "function" ? this.publicUrl() : this.publicUrl || "").replace(/\/+$/, "");
    if (base.startsWith("https://")) {
      await this.#call("setChatMenuButton", {
        menu_button: { type: "web_app", text: tIn("ru-RU", "telegram.menuButton"), web_app: { url: `${base}/` } },
      }).catch((error) => console.warn(`[telegram] menu button: ${error.message}`));
    }
    return true;
  }

  start() {
    if (this.timer) return;
    this.publishCommands().catch((error) => console.warn(`[telegram] could not publish commands: ${error.message}`));
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

  // Somebody tapped "Озвучить" under a message. The text comes back with the
  // press, so there is nothing to remember between sending and tapping.
  //
  // The same rule as every other inbound event: a chat that is not linked is a
  // stranger, and a stranger's button press reaches no service of ours.
  async #handleSpeakTap(callback) {
    const chatId = callback?.message?.chat?.id;
    const text = clean(callback?.message?.text, 4000);
    const answer = (message = "") => this.#call("answerCallbackQuery", {
      callback_query_id: callback.id,
      ...(message ? { text: message } : {}),
    }).catch(() => {});

    if (!chatId || !text) return answer();
    const linked = Object.values(this.#read()).some((value) => value.chatId === chatId);
    if (!linked) return answer(tIn(this.#chatLocale(chatId), "telegram.sys.strangerChat"));

    // Telegram spins the button until it is answered, so the acknowledgement
    // goes first and the synthesis — which takes seconds — follows.
    await answer(tIn(this.#chatLocale(chatId), "telegram.sys.speaking"));
    try {
      const audio = await this.speaker.speak(text);
      if (!audio) {
        await this.#call("sendMessage", { chat_id: chatId, text: tIn(this.#chatLocale(chatId), "telegram.sys.tooLongToListen") });
        return;
      }
      await this.#sendVoice(chatId, audio);
    } catch (error) {
      console.warn(`[telegram] speak-on-tap failed: ${error.message}`);
      await this.#call("sendMessage", { chat_id: chatId, text: tIn(this.#chatLocale(chatId), "telegram.sys.speakFailed") }).catch(() => {});
    }
  }

  // Somebody tapped Done, +1 hour, Tonight or Got it.
  //
  // The chat is the authentication, exactly as it is for a typed message: a
  // chat id is in the link table only because its owner put it there from a
  // signed-in session. So the verb is applied to that person's own inbox and
  // nobody else's, and a press from an unlinked chat reaches nothing.
  async #handleActionTap(callback) {
    const chatId = callback?.message?.chat?.id;
    const answer = (text = "") => this.#call("answerCallbackQuery", {
      callback_query_id: callback.id,
      ...(text ? { text } : {}),
    }).catch(() => {});

    const parsed = parseCallback(callback?.data);
    if (!chatId || !parsed) return answer();
    const userId = this.#userIdForChat(chatId);
    if (!userId) return answer(tIn(this.#chatLocale(chatId), "telegram.sys.strangerChat"));

    const locale = this.localeFor(userId);
    const T = (key, values) => tIn(locale, key, values);

    try {
      if (parsed.action === "d" || parsed.action === "a") {
        const updated = this.workspaces.updateInboxItem(userId, parsed.id, {
          status: parsed.action === "d" ? "archived" : "read",
        });
        // Plenty of what arrives here was never an inbox item — the ERP
        // anomalies and the evening summary are composed on the fly. Saying so
        // is better than a button that silently does nothing.
        if (!updated) return answer(T("telegram.actionGone"));
        await answer(T(parsed.action === "d" ? "telegram.done" : "telegram.acked"));
        return this.#strikeKeyboard(chatId, callback.message.message_id);
      }

      if (parsed.action === "s") {
        if (!this.reminders) return answer(T("telegram.actionFailed"));
        const item = this.workspaces.listInbox(userId, { limit: 200 })
          .find((entry) => entry.id === parsed.id);
        if (!item) return answer(T("telegram.actionGone"));
        const due = this.#snoozeTarget(parsed.arg, userId);
        this.reminders.create(userId, {
          title: item.title || T("telegram.card.reminder"),
          body: item.body,
          dueAt: due.toISOString(),
          route: item.route,
        });
        this.workspaces.updateInboxItem(userId, parsed.id, { status: "archived" });
        await answer(T("telegram.snoozed", { time: this.#clock(due, userId) }));
        return this.#strikeKeyboard(chatId, callback.message.message_id);
      }
    } catch (error) {
      console.warn(`[telegram] action ${parsed.action} failed for ${userId}: ${error.message}`);
      return answer(T("telegram.actionFailed"));
    }
    return answer();
  }

  // An hour from now, or this evening in the person's own timezone. "Evening"
  // has to mean their evening: the factory is in Andijan and the owner is not
  // always there.
  #snoozeTarget(arg, userId) {
    const now = new Date();
    if (arg !== "evening") return new Date(now.getTime() + (Number(arg) || 60) * 60000);
    const zone = this.#timezone(userId);
    const hourNow = Number(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hour12: false }).format(now));
    // 19:00 tonight, or tomorrow evening if tonight has already been and gone.
    const days = hourNow >= 19 ? 1 : 0;
    const target = new Date(now.getTime() + days * 86400000);
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(target);
    const offset = this.#zoneOffset(zone, now);
    return new Date(`${parts}T19:00:00${offset}`);
  }

  #timezone(userId) {
    try {
      const user = this.#user(userId);
      return (user && this.onboarding.get(user).profile?.timezone) || "Asia/Tashkent";
    } catch {
      return "Asia/Tashkent";
    }
  }

  // Intl gives the offset as "GMT+5"; an ISO string needs "+05:00".
  #zoneOffset(zone, at) {
    const label = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at).find((part) => part.type === "timeZoneName")?.value || "GMT+00:00";
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(label);
    if (!match) return "+00:00";
    return `${match[1]}${match[2].padStart(2, "0")}:${match[3] || "00"}`;
  }

  #clock(date, userId) {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: this.#timezone(userId), hour: "2-digit", minute: "2-digit",
    }).format(date);
  }

  // The buttons come off once the verb has been applied, so the card cannot be
  // completed twice and reads as settled in the scrollback.
  async #strikeKeyboard(chatId, messageId) {
    if (!messageId) return;
    await this.#call("editMessageReplyMarkup", {
      chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }

  // Public: the poller calls it per update, and tests drive it directly —
  // simulating the person tapping Start is the only honest way to test linking.
  async handleUpdateForTest(update) {
    if (update?.callback_query?.data === SPEAK_CALLBACK) {
      return this.#handleSpeakTap(update.callback_query);
    }
    if (update?.callback_query?.data) {
      return this.#handleActionTap(update.callback_query);
    }
    const message = update.message;
    const chatId = message?.chat?.id;
    // Commands are short; a real question to MILA is not. 4000 matches one
    // Telegram message, so nothing a person can type in one go is cut.
    let text = clean(message?.text || message?.caption, 4000);

    // A voice note is a question like any other: transcribe it and carry on.
    // Silence here was the worst answer available — the person cannot tell a
    // bot that ignores audio from a bot that has died.
    const audio = !text && chatId ? audioFileId(message) : null;
    if (audio) {
      await this.#call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      try {
        text = clean(await this.voice.transcribe(this.token(), audio.fileId), 4000);
        await this.#call("sendMessage", { chat_id: chatId, text: `🎤 «${text}»` });
      } catch (error) {
        console.warn(`[telegram] transcription failed: ${error.message}`);
        await this.#call("sendMessage", {
          chat_id: chatId,
          text: tIn(this.#chatLocale(chatId, message?.from), "telegram.sys.voiceUnclear"),
        });
        return;
      }
    }

    // Everything else Telegram can carry — photos, documents, stickers — says
    // so rather than vanishing.
    if (!text && chatId && (message?.photo || message?.document || message?.video)) {
      await this.#call("sendMessage", {
        chat_id: chatId,
        text: tIn(this.#chatLocale(chatId, message?.from), "telegram.sys.filesUnsupported"),
      });
      return;
    }
    if (!chatId || !text) return;

    if (text.startsWith("/start")) {
      const code = clean(text.split(/\s+/)[1], 64);
      const userId = code ? this.#consumeCode(code) : null;
      if (!userId) {
        await this.#call("sendMessage", {
          chat_id: chatId,
          text: tIn(this.#chatLocale(chatId, message?.from), "telegram.sys.linkExpired"),
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
        text: tIn(this.#chatLocale(chatId, message?.from), "telegram.sys.linked"),
      });
      return;
    }

    // /today, /tasks and /erp are questions, not features. Each is put to MILA
    // exactly as if the person had typed it, so they inherit her tools, her
    // audience gate and her tone rather than growing a second answering path
    // that would drift from the first.
    const command = /^\/([a-z]+)/.exec(text)?.[1] || "";
    if (Object.hasOwn(ASSISTANT_COMMANDS, command)) {
      const asker = this.#userIdForChat(chatId);
      if (!asker || !this.assistant) {
        await this.#call("sendMessage", {
          chat_id: chatId,
          text: tIn(this.#chatLocale(chatId, message?.from), "telegram.sys.notLinked"),
        });
        return;
      }
      const locale = this.localeFor(asker);
      await this.#call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      const reply = await this.assistant.respond(asker, tIn(locale, ASSISTANT_COMMANDS[command]));
      if (reply) {
        for (let start = 0; start < reply.length; start += CHUNK) {
          await this.#call("sendMessage", {
            chat_id: chatId,
            text: reply.slice(start, start + CHUNK),
            reply_markup: speakButton(locale),
          });
        }
      }
      return;
    }

    if (text.startsWith("/ask")) {
      const asker = this.#userIdForChat(chatId);
      await this.#call("sendMessage", {
        chat_id: chatId,
        text: tIn(asker ? this.localeFor(asker) : "ru-RU", "telegram.ask.prompt"),
      });
      return;
    }

    if (text.startsWith("/help")) {
      await this.#call("sendMessage", {
        chat_id: chatId,
        text: tIn(this.#chatLocale(chatId, message?.from), "telegram.help.body"),
      });
      return;
    }

    if (text.startsWith("/stop")) {
      // Resolved before the link goes, or the goodbye is in the wrong language.
      const locale = this.#chatLocale(chatId, message?.from);
      const all = this.#read();
      const entry = Object.entries(all).find(([, value]) => value.chatId === chatId);
      if (entry) {
        delete all[entry[0]];
        this.#write(all);
      }
      await this.#call("sendMessage", { chat_id: chatId, text: tIn(locale, "telegram.sys.unlinked") });
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
          await this.#call("sendMessage", {
            chat_id: chatId,
            text: reply.slice(start, start + CHUNK),
            reply_markup: speakButton(this.#chatLocale(chatId, message?.from)),
          });
        }
        // Asked out loud, answered out loud. Somebody who spoke because their
        // hands are busy cannot read the reply either — but the text goes
        // first and stays, because a voice message cannot be searched, quoted
        // or read during a meeting.
        if (audio) {
          try {
            const spoken = await this.speaker.speak(reply);
            if (spoken) await this.#sendVoice(chatId, spoken);
          } catch (error) {
            console.warn(`[telegram] could not speak the reply: ${error.message}`);
          }
        }
        return;
      }
      // The account behind the link is gone or disabled: drop the orphan link
      // rather than keep a dead man's chat half-alive.
      this.unlink(link[0]);
    }
    await this.#call("sendMessage", {
      chat_id: chatId,
      text: tIn(this.#chatLocale(chatId, message?.from), "telegram.sys.notLinked"),
    });
  }

  // Audio goes as multipart, so it cannot ride #call's JSON body. Kept next to
  // it rather than folded in: one shape per transport is easier to read than a
  // branch inside the shared one.
  async #sendVoice(chatId, bytes, caption = "") {
    const token = this.token();
    if (!token) throw new Error("no bot token");
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("voice", new Blob([bytes], { type: "audio/ogg" }), "mila.ogg");
    if (caption) form.append("caption", clean(caption, 900));
    const response = await this.fetch(`${API}/bot${token}/sendVoice`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    const json = await response.json().catch(() => ({}));
    if (!json.ok) throw new Error(clean(json.description, 200) || `telegram sendVoice HTTP ${response.status}`);
    return json.result;
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
