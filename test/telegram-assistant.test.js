// MILA in a linked Telegram chat: the text tool loop.
//
// The proxy to Gemini is text-in, text-out, so tools run over a protocol: the
// model answers with one TOOL_CALL line, the server executes it AS THE LINK'S
// OWNER through the same gate the phone lives behind, and feeds a TOOL_RESULT
// back. What these tests defend: identity comes from the link, the gate never
// widens, and she cannot claim an action happened without a result proving it.

import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramAssistant } from "../server/lib/telegram-assistant.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };

function assistant({ script = [], actionResult = { ok: true } } = {}) {
  const chatCalls = [];
  const actionCalls = [];
  let step = 0;
  const instance = createTelegramAssistant({
    chat: async (_cfg, _label, request) => {
      chatCalls.push(request);
      return { text: script[Math.min(step++, script.length - 1)] };
    },
    actions: {
      call: async (name, args, context) => {
        actionCalls.push({ name, args, context });
        if (actionResult instanceof Error) throw actionResult;
        return actionResult;
      },
    },
    sharedAgentContext: () => "Workspace: Milana Premium\nWhat Бахадыр has told you about themselves:\n- Звонить после десяти",
    db: { integrations: { byProvider: () => ({ config: { baseUrl: "http://mila.test" } }) } },
    users: { get: () => null },
    creatorUser: () => OWNER,
  });
  return { instance, chatCalls, actionCalls };
}

test("prose comes straight back, with the owner's own context in the prompt", async () => {
  const a = assistant({ script: ["Сегодня у вас две встречи."] });
  const reply = await a.instance.respond("creator", "что сегодня?");
  assert.equal(reply, "Сегодня у вас две встречи.");
  // Their own chat is audience "owner": profile facts belong in the prompt.
  assert.match(a.chatCalls[0].systemPrompt, /Звонить после десяти/);
  assert.match(a.chatCalls[0].systemPrompt, /TOOL_CALL/);
  assert.equal(a.actionCalls.length, 0);
});

test("a TOOL_CALL runs as the link's owner and the loop ends in prose", async () => {
  const a = assistant({
    script: [
      'TOOL_CALL {"name":"remind_me","args":{"title":"Позвонить на фабрику","dueAt":"2026-08-15T10:00:00+05:00"}}',
      "Готово — напомню завтра в десять.",
    ],
    actionResult: { ok: true, action: "remind_me" },
  });
  const reply = await a.instance.respond("creator", "напомни завтра в 10 позвонить на фабрику");
  assert.equal(reply, "Готово — напомню завтра в десять.");
  assert.equal(a.actionCalls.length, 1);
  assert.equal(a.actionCalls[0].name, "remind_me");
  // Identity flows from the resolved account, never from the message text.
  assert.equal(a.actionCalls[0].context.user.id, "creator");
  // The second model turn saw the proof.
  assert.match(a.chatCalls[1].messages.at(-1).content, /^TOOL_RESULT /);
  assert.match(a.chatCalls[1].messages.at(-1).content, /"ok":true/);
});

test("the gate is the phone's gate: operator tools are refused, not executed", async () => {
  const a = assistant({
    script: [
      'TOOL_CALL {"name":"delegate_to_hermes","args":{"title":"взлом"}}',
      "Этого я отсюда не могу — попросите в приложении.",
    ],
  });
  const reply = await a.instance.respond("creator", "поставь задачу флоту");
  assert.equal(a.actionCalls.length, 0, "the action must never run");
  assert.match(a.chatCalls[1].messages.at(-1).content, /not available in Telegram/);
  assert.match(reply, /не могу/);
});

test("a failed tool becomes a TOOL_RESULT, so she cannot report success", async () => {
  const a = assistant({
    script: [
      'TOOL_CALL {"name":"remind_me","args":{}}',
      "Не вышло поставить напоминание: нужно время.",
    ],
    actionResult: Object.assign(new Error("Reminder time is invalid"), { status: 400 }),
  });
  const reply = await a.instance.respond("creator", "напомни");
  assert.match(a.chatCalls[1].messages.at(-1).content, /Reminder time is invalid/);
  assert.match(reply, /Не вышло/);
});

test("a runaway tool loop is cut off instead of spinning forever", async () => {
  const a = assistant({ script: ['TOOL_CALL {"name":"list_my_tasks","args":{}}'] });
  const reply = await a.instance.respond("creator", "зациклись");
  assert.ok(a.actionCalls.length <= 5, `took ${a.actionCalls.length} tool rounds`);
  assert.match(reply, /попробуйте/i);
});

test("an unknown or disabled account gets null — the bridge unlinks it", async () => {
  const a = assistant({ script: ["не должно дойти"] });
  assert.equal(await a.instance.respond("usr_gone", "привет"), null);
  assert.equal(a.chatCalls.length, 0);
});

test("history is kept per user and bounded", async () => {
  const a = assistant({ script: ["ок"] });
  for (let i = 0; i < 20; i += 1) await a.instance.respond("creator", `вопрос ${i}`);
  const last = a.chatCalls.at(-1).messages;
  assert.ok(last.length <= 12, `history grew to ${last.length}`);
  assert.equal(a.instance.historySize(), 1);
});
