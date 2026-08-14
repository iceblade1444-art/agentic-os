// /learn: what the operator approves is the skill itself, not a promise.

import assert from "node:assert/strict";
import test from "node:test";

import { createSkillLearner } from "../server/lib/skill-learner.js";
import { createMilaActions } from "../server/lib/mila-actions.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };

const GOOD_SKILL = JSON.stringify({
  name: "milana-sample-answer",
  description: "Ответ на запрос образцов",
  category: "sales",
  body: "# Образцы\n\n## Когда применять\nЗапрос образцов.\n\n## Шаги\n1. Уточни модели.\n\n## Типовые ошибки\n- Обещать бесплатную доставку.\n\n## Как проверить\nЕсть срок и цена доставки.",
});

function learner({ reply = GOOD_SKILL, existing = null } = {}) {
  const requests = [];
  const instance = createSkillLearner({
    chat: async (_cfg, _label, request) => { learner.lastPrompt = request; return { text: reply }; },
    milaConfig: () => ({ baseUrl: "http://mila.test" }),
    skillsRequest: async (path, options = {}) => {
      requests.push({ path, options });
      if (path.startsWith("/api/skills/content?") && !options.method) {
        if (existing === null) throw new Error("not found");
        return { content: existing };
      }
      return { success: true };
    },
  });
  return { instance, requests };
}

test("a described process becomes a validated draft and installs as given", async () => {
  const f = learner();
  const draft = await f.instance.draft({ instruction: "Когда клиент просит образцы: уточняем модели, считаем доставку, называем срок." });
  assert.equal(draft.name, "milana-sample-answer");
  assert.equal(draft.update, false);
  assert.ok(draft.description.length <= 60);

  await f.instance.install(draft);
  const install = f.requests.find((request) => request.options.method === "POST");
  assert.match(install.options.body.content, /^---\nname: milana-sample-answer/);
  assert.match(install.options.body.content, /## Как проверить/);
});

test("feedback against an existing name refines it instead of forking", async () => {
  const f = learner({ existing: "---\nname: milana-sample-answer\n---\n\n# Старая версия" });
  const draft = await f.instance.draft({ instruction: "Добавь: образцы платные, вычитаются из первого заказа.", name: "milana-sample-answer" });
  assert.equal(draft.update, true);
  // The model saw the current skill, so feedback lands as a revision.
  assert.match(learner.lastPrompt.messages[0].content, /Старая версия/);
  await f.instance.install(draft);
  assert.ok(f.requests.some((request) => request.options.method === "PUT"), "an update PUTs content, never creates a twin");
});

test("model output that is not a four-section skill is refused", async () => {
  const missing = learner({ reply: JSON.stringify({ name: "x-y-z", description: "d", category: "c", body: "# Без секций" }) });
  await assert.rejects(missing.instance.draft({ instruction: "Процесс из одного шага, но достаточно длинный для черновика." }), (error) => error.status === 502);

  const prose = learner({ reply: "Вот ваш скилл: ..." });
  await assert.rejects(prose.instance.draft({ instruction: "Достаточно длинное описание процесса для проверки." }), (error) => error.status === 502);
});

test("through MILA it is operator-only, two-step, and the draft is what gets confirmed", async () => {
  const f = learner();
  let installed = null;
  const actions = createMilaActions({
    skillLearner: {
      draft: (args) => f.instance.draft(args),
      install: async (draft) => { installed = draft; return { success: true }; },
    },
    journal: { append: async () => null, recentText: () => "" },
    onboarding: { get: () => ({ profile: {} }) },
    db: { mcp: { list: () => [], update: () => {} } },
  });

  const staged = await actions.call("learn_skill", { instruction: "Когда клиент просит образцы: уточняем модели, считаем доставку, называем срок." }, { actor: OWNER.name, user: OWNER });
  assert.equal(staged.confirmationRequired, true);
  assert.match(staged.summary, /milana-sample-answer/);
  assert.ok(staged.draft.body.includes("## Шаги"), "the operator sees the actual draft before confirming");
  assert.equal(installed, null, "nothing installs before confirmation");

  const done = await actions.call("learn_skill", { confirmationToken: staged.confirmationToken }, { actor: OWNER.name, user: OWNER });
  assert.equal(done.ok, true);
  assert.equal(installed.name, "milana-sample-answer");
});
