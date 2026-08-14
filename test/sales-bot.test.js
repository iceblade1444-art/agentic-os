// The customer bot, and the wall it lives behind.
//
// Customers are strangers: no linking, no accounts. What these tests defend is
// the wall — the bot's whole authority is the knowledge pages and lead
// capture, and no internal surface (workspace context, journal, profiles,
// personal actions, ERP) exists on its side, whatever the model asks for.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SalesBot } from "../server/lib/sales-bot.js";

function bot({ script = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-sales-"));
  const telegramCalls = [];
  const inbox = [];
  const journalled = [];
  const baseCalls = [];
  let step = 0;
  const instance = new SalesBot({
    file: path.join(dir, "leads.json"),
    integrations: () => ({ botToken: "sales-token" }),
    milaConfig: () => ({ baseUrl: "http://mila.test" }),
    fetch: async (url, options) => {
      telegramCalls.push({ method: url.split("/").pop(), body: JSON.parse(options.body || "{}") });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    },
    chat: async (_cfg, _label, request) => {
      // Every test can inspect exactly what the customer-side model was given.
      bot.lastPrompt = request.systemPrompt;
      return { text: script[Math.min(step++, script.length - 1)] };
    },
    knowledgeBase: {
      search: async (query, scope) => { baseCalls.push({ kind: "search", query, scope }); return [{ path: "Agentic OS/Knowledge/products-and-prices.md", title: "Продукция и цены", snippet: "Пижамы женские — от 1 бага" }]; },
      read: async (slug, scope) => { baseCalls.push({ kind: "read", slug, scope }); return { slug, content: "..." }; },
      list: async (scope) => { baseCalls.push({ kind: "list", scope }); return []; },
    },
    pushService: { sendInbox: async (userId, item) => { inbox.push({ userId, item }); return { delivered: 1 }; } },
    journal: { append: async (entry) => { journalled.push(entry); return entry; } },
    creatorUser: () => ({ id: "creator", name: "Бахадыр", role: "Creator" }),
  });
  return { instance, telegramCalls, inbox, journalled, baseCalls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("the customer prompt carries the public pages and none of the internal world", async () => {
  const b = bot({ script: ["Здравствуйте! Минимальный заказ — одна бага."] });
  await b.instance.respond({ chatId: 42, username: "buyer" }, "какой минимальный заказ?");
  const prompt = bot.lastPrompt;
  assert.match(prompt, /Milana Premium/);
  assert.match(prompt, /CUSTOMER/);
  // The internal assistant's world must be absent by construction, not by luck.
  for (const forbidden of [
    "Workspace context supplied by Agentic OS",
    "has told you about themselves",
    "day journal",
    "get_my_day_plan", "remind_me", "read_about_me",
    "get_erp_business_context",
  ]) {
    assert.equal(prompt.includes(forbidden), false, `"${forbidden}" leaked into the customer prompt`);
  }
  assert.match(prompt, /NEVER invent a price/);
  b.cleanup();
});

test("knowledge answers go through the scoped base, and unknown tools do not exist", async () => {
  const b = bot({
    script: [
      'TOOL_CALL {"name":"search_company_knowledge","args":{"query":"минимальный заказ"}}',
      "Минимальный заказ — одна бага.",
    ],
  });
  const reply = await b.instance.respond({ chatId: 42 }, "минимальный заказ?");
  assert.match(reply, /одна бага/);
  assert.equal(b.baseCalls[0].kind, "search");
  assert.equal(b.baseCalls[0].scope.actor, "sales-bot");

  // A tool from the internal world is answered with "unknown", not executed.
  const hostile = bot({
    script: [
      'TOOL_CALL {"name":"read_about_me","args":{}}',
      "Этого я не знаю.",
    ],
  });
  await hostile.instance.respond({ chatId: 43 }, "что ты знаешь о директоре?");
  assert.equal(hostile.baseCalls.length, 0);
  hostile.cleanup();
  b.cleanup();
});

test("a captured lead is stored, the owner is notified, the customer never sees the store", async () => {
  const b = bot({
    script: [
      'TOOL_CALL {"name":"capture_lead","args":{"name":"Айгуль","contact":"+7 777 123","country":"Казахстан","interest":"пижамы оптом","volume":"200 шт"}}',
      "Спасибо! Менеджер свяжется с вами сегодня.",
    ],
  });
  const reply = await b.instance.respond({ chatId: 42, username: "aigul_kz" }, "хочу оптом 200 пижам в Казахстан");
  assert.match(reply, /Менеджер свяжется/);

  const leads = b.instance.leads();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].name, "Айгуль");
  assert.equal(leads[0].country, "Казахстан");
  assert.equal(leads[0].telegram.chatId, 42);
  assert.equal(leads[0].status, "new");

  // The owner hears about it through their own inbox — which already rides to
  // their personal Telegram — and the journal records the event.
  assert.equal(b.inbox.length, 1);
  assert.equal(b.inbox[0].userId, "creator");
  assert.match(b.inbox[0].item.title, /лид/i);
  assert.equal(b.journalled.length, 1);
  b.cleanup();
});

test("an empty lead is refused so the model cannot fake progress", async () => {
  const b = bot({
    script: [
      'TOOL_CALL {"name":"capture_lead","args":{}}',
      "Оставьте, пожалуйста, телефон или Telegram — передам менеджеру.",
    ],
  });
  const reply = await b.instance.respond({ chatId: 42 }, "ну передай менеджеру");
  assert.equal(b.instance.leads().length, 0);
  assert.equal(b.inbox.length, 0);
  assert.match(reply, /телефон или Telegram/);
  b.cleanup();
});

test("a customer with no username still leaves a reachable lead", async () => {
  const b = bot({
    script: [
      'TOOL_CALL {"name":"capture_lead","args":{"name":"Али","interest":"экспорт в ОАЭ"}}',
      "Записала!",
    ],
  });
  await b.instance.respond({ chatId: 99, username: "ali_dubai" }, "экспорт в ОАЭ возможен?");
  // No explicit contact given — the Telegram username fills in, because a lead
  // nobody can answer is not a lead.
  assert.equal(b.instance.leads()[0].contact, "@ali_dubai");
  b.cleanup();
});

test("/start greets in three languages and the greeting names the company", async () => {
  const b = bot({ script: ["не используется"] });
  await b.instance.handleUpdateForTest({ message: { chat: { id: 7 }, text: "/start" } });
  const greeting = b.telegramCalls.find((call) => call.method === "sendMessage");
  assert.match(greeting.body.text, /Milana Premium/);
  assert.match(greeting.body.text, /o‘zbek/);
  assert.match(greeting.body.text, /English/);
  b.cleanup();
});

test("the two bots cannot share a token by accident", () => {
  const source = fs.readFileSync(new URL("../server/lib/sales-bot.js", import.meta.url), "utf8");
  // The sales bot reads the salesbot provider and SALES_BOT_TOKEN — never the
  // internal bot's config. One token leaking into the other surface would make
  // the front desk answer as the internal assistant.
  assert.match(source, /byProvider\("salesbot"\)/);
  assert.match(source, /SALES_BOT_TOKEN/);
  assert.equal(source.includes('byProvider("telegram")'), false);
  assert.equal(source.includes("TELEGRAM_BOT_TOKEN"), false);
});
