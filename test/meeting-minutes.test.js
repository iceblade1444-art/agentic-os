// Transcript in, protocol out — with nothing invented on the way.

import assert from "node:assert/strict";
import test from "node:test";

import { createMeetingMinutes } from "../server/lib/meeting-minutes.js";

function fixture({ reply } = {}) {
  const chatCalls = [];
  const created = [];
  const journalled = [];
  const instance = createMeetingMinutes({
    chat: async (_cfg, _label, request) => { chatCalls.push(request); return { text: reply }; },
    milaConfig: () => ({ baseUrl: "http://mila.test" }),
    knowledge: { create: async (path, content, scope) => { created.push({ path, content, scope }); return { path }; } },
    journal: { append: async (entry) => { journalled.push(entry); return entry; } },
  });
  return { instance, chatCalls, created, journalled };
}

const TRANSCRIPT = "так коллеги по срокам отгрузка в казахстан переносится на двадцатое августа " +
  "шавкат берёт на себя сертификаты азиз проверь склад по модели восемьсот пять до пятницы всё";

test("a meeting becomes decisions, assignments and a vault note", async () => {
  const f = fixture({
    reply: JSON.stringify({
      title: "Планёрка по отгрузке",
      summary: "Отгрузка в Казахстан перенесена на 20 августа.",
      decisions: ["Отгрузка в Казахстан — 20 августа"],
      actions: [
        { title: "Подготовить сертификаты", owner: "Шавкат", due: "" },
        { title: "Проверить склад по модели 805", owner: "Азиз", due: "2026-08-15" },
      ],
      open_questions: ["Кто везёт образцы?"],
    }),
  });
  const minutes = await f.instance.minutes(TRANSCRIPT, { actor: "Бахадыр", timezone: "Asia/Tashkent" });

  assert.equal(minutes.title, "Планёрка по отгрузке");
  assert.equal(minutes.actions.length, 2);
  assert.equal(minutes.actions[1].due, "2026-08-15");
  assert.match(minutes.savedTo, /^Agentic OS\/Meetings\/\d{4}-\d{2}-\d{2} \d{4} — Планёрка по отгрузке\.md$/);

  // The note is a readable protocol, and the journal records the meeting
  // without carrying its content into every agent's context.
  assert.match(f.created[0].content, /## Решения/);
  assert.match(f.created[0].content, /\[ \] Проверить склад по модели 805 — Азиз \(до 2026-08-15\)/);
  assert.match(f.journalled[0].title, /Протокол: Планёрка/);
  assert.equal(f.journalled[0].title.includes("Казахстан"), false);
});

test("model noise is rejected: fenced JSON is fine, prose is a 502, junk dates are dropped", async () => {
  const fenced = fixture({
    reply: '```json\n{"title":"Т","summary":"s","decisions":[],"actions":[{"title":"Позвонить","owner":"","due":"завтра"}],"open_questions":[]}\n```',
  });
  const minutes = await fenced.instance.minutes(TRANSCRIPT);
  assert.equal(minutes.actions[0].due, "", "a spoken 'завтра' is not a date and must not become one");

  const prose = fixture({ reply: "К сожалению, не получилось." });
  await assert.rejects(prose.instance.minutes(TRANSCRIPT), (error) => error.status === 502);
});

test("a torn transcript is refused and an unsaved note is admitted, not claimed", async () => {
  const f = fixture({ reply: "{}" });
  await assert.rejects(f.instance.minutes("коротко"), (error) => error.status === 400);

  const broken = createMeetingMinutes({
    chat: async () => ({ text: '{"title":"Т","summary":"s","decisions":[],"actions":[],"open_questions":[]}' }),
    milaConfig: () => ({ baseUrl: "http://mila.test" }),
    knowledge: { create: async () => { throw new Error("vault offline"); } },
    journal: { append: async () => null },
  });
  const minutes = await broken.minutes(TRANSCRIPT);
  assert.equal(minutes.savedTo, "", "the protocol still returns, but never claims a file that does not exist");
});
