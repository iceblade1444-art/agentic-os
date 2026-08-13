import assert from "node:assert/strict";
import test from "node:test";

import { KNOWLEDGE_PAGES, knowledgePromptIndex, knowledgePageTemplate, KNOWLEDGE_PAGE_SLUGS } from "../assets/js/knowledge-pages.js";
import { createKnowledgeBase, KNOWLEDGE_FOLDER } from "../server/lib/knowledge-base.js";
import { createMilaActions, KNOWLEDGE_ACTIONS } from "../server/lib/mila-actions.js";
import { MILA_KNOWLEDGE_TOOLS, MILA_MEMBER_TOOLS, MILA_TOOLS } from "../assets/js/mila-tools.js";
import { buildMilaSystemInstruction, AGENT_CONTEXT_LIMIT } from "../assets/js/mila-prompt.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };

// A vault stand-in: enough of the library's shape for the base to work against.
function vault(seed = {}) {
  const notes = { ...seed };
  return {
    notes,
    library: {
      list: async () => Object.keys(notes).map((path) => ({ path, title: path.split("/").at(-1) })),
      read: async (path) => {
        if (!(path in notes)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { path, content: notes[path], size: notes[path].length };
      },
      create: async (path, content) => { notes[path] = content; return { path, content, size: content.length }; },
      append: async (path, text) => { notes[path] = (notes[path] || "") + text; return { path, content: notes[path], size: notes[path].length }; },
      search: async (query) => ({
        matches: Object.entries(notes)
          .filter(([, body]) => body.toLowerCase().includes(String(query).toLowerCase()))
          .map(([path, body]) => ({ path, title: path.split("/").at(-1), snippet: body.slice(0, 200) })),
      }),
    },
  };
}

test("the prompt carries an index, never the pages themselves", () => {
  const index = knowledgePromptIndex();
  assert.ok(index.length <= 700, `the index must stay small, got ${index.length}`);
  for (const page of KNOWLEDGE_PAGES) {
    assert.ok(index.includes(page.slug), `${page.slug} must be findable from the prompt`);
  }
  // The whole point: a page is opened on demand, so its body never competes for
  // the 9000 characters the workspace facts and the playbook already share.
  const body = knowledgePageTemplate(KNOWLEDGE_PAGES[0]);
  assert.equal(index.includes(body.slice(0, 60)), false);
});

test("a page is created from its template the first time it is read", async () => {
  const v = vault();
  const base = createKnowledgeBase({ knowledge: v.library });
  const page = await base.read("products-and-prices");
  assert.match(page.content, /# Продукция и цены/);
  assert.match(page.content, /## Составы тканей/);
  // The unknowns are marked, so she asks rather than inventing a fabric.
  assert.match(page.content, /❔/);
  assert.equal(page.path, `${KNOWLEDGE_FOLDER}/products-and-prices.md`);
  assert.ok(v.notes[page.path]);
});

test("an unknown page is refused rather than invented", async () => {
  const base = createKnowledgeBase({ knowledge: vault().library });
  await assert.rejects(base.read("secret-margins"), (error) => error.status === 404);
  await assert.rejects(base.addFact("secret-margins", { fact: "..." }), (error) => error.status === 404);
});

test("search never reaches outside the knowledge folder", async () => {
  const v = vault({
    [`${KNOWLEDGE_FOLDER}/products-and-prices.md`]: "Минимальная партия — одна бага",
    "Agentic OS/Marketing Playbook.md": "Минимальная партия — внутренняя заметка для операторов",
    "Personal/Salaries.md": "Минимальная партия упомянута и здесь",
  });
  const base = createKnowledgeBase({ knowledge: v.library });
  const hits = await base.search("минимальная партия");
  assert.equal(hits.length, 1);
  assert.match(hits[0].path, /^Agentic OS\/Knowledge\//);
});

test("a dictated fact lands under a heading, quotable and attributed", async () => {
  const v = vault();
  const base = createKnowledgeBase({ knowledge: v.library });
  const written = await base.addFact("products-and-prices", {
    section: "Минимальная партия и отсрочки",
    fact: "Минимальная партия — одна бага",
    author: "Бахадыр",
  });
  assert.equal(written.section, "Минимальная партия и отсрочки");
  const body = v.notes[`${KNOWLEDGE_FOLDER}/products-and-prices.md`];
  assert.match(body, /## Минимальная партия и отсрочки/);
  assert.match(body, /- Минимальная партия — одна бага — записал Бахадыр, \d{4}-\d{2}-\d{2}/);

  // An unknown heading falls back rather than silently creating a new structure.
  const stray = await base.addFact("products-and-prices", { section: "Придуманный раздел", fact: "Отсрочка 30 дней" });
  assert.ok(KNOWLEDGE_PAGES[0].sections.includes(stray.section));
  await assert.rejects(base.addFact("products-and-prices", { fact: " " }), (error) => error.status === 400);
});

test("employees may read the knowledge base but not rewrite it", () => {
  const memberNames = MILA_MEMBER_TOOLS.map((tool) => tool.name);
  for (const name of ["search_company_knowledge", "read_company_knowledge", "list_company_knowledge"]) {
    assert.ok(memberNames.includes(name), `${name} must be available to an employee`);
    assert.ok(KNOWLEDGE_ACTIONS.has(name), `${name} must pass the route's everyone gate`);
  }
  // Everyone quotes these pages afterwards, so writing is the owner's.
  assert.equal(memberNames.includes("save_company_knowledge"), false);
  assert.equal(KNOWLEDGE_ACTIONS.has("save_company_knowledge"), false);
  for (const tool of MILA_KNOWLEDGE_TOOLS) {
    assert.ok(MILA_TOOLS.some((item) => item.name === tool.name));
  }
});

test("reading is one step; writing is staged and confirmed", async () => {
  const v = vault();
  const base = createKnowledgeBase({ knowledge: v.library });
  let token = 0;
  const actions = createMilaActions({
    knowledgeBase: base,
    journal: { append: async () => null, recentText: () => "" },
    onboarding: { get: () => ({ profile: {} }) },
    makeToken: () => `confirm_${++token}`,
    db: { mcp: { list: () => [], update: () => {} } },
  });
  const context = { actor: "Бахадыр", user: OWNER };

  const read = await actions.call("read_company_knowledge", { page: "who-does-what" }, context);
  assert.match(read.content, /Кто за что отвечает/);
  assert.match(read.source_policy, /never invent a company fact/);

  // Reading seeds the page from its template, so the base fills itself in and
  // nobody has to create files by hand — that write is the empty skeleton.
  assert.deepEqual(Object.keys(v.notes), [`${KNOWLEDGE_FOLDER}/who-does-what.md`]);

  const staged = await actions.call("save_company_knowledge", {
    page: "products-and-prices", section: "Прайс и условия", fact: "Отсрочка для постоянных клиентов — 14 дней",
  }, context);
  assert.equal(staged.confirmationRequired, true);
  assert.match(staged.summary, /Отсрочка для постоянных клиентов/);
  assert.equal(
    Object.keys(v.notes).some((path) => (v.notes[path] || "").includes("Отсрочка")),
    false,
    "no fact may be written before confirmation",
  );

  await actions.call("save_company_knowledge", { confirmationToken: staged.confirmationToken }, context);
  assert.match(v.notes[`${KNOWLEDGE_FOLDER}/products-and-prices.md`], /Отсрочка для постоянных клиентов — 14 дней/);
});

test("the knowledge rules reach the prompt only when the tools do", () => {
  const withTools = buildMilaSystemInstruction({
    tools: KNOWLEDGE_PAGE_SLUGS.length ? ["search_company_knowledge", "save_company_knowledge"] : [],
    knowledgeIndex: knowledgePromptIndex(),
  });
  assert.match(withTools, /search_company_knowledge/);
  assert.match(withTools, /products-and-prices/);
  assert.match(withTools, /never fill the gap yourself|Never fill the gap yourself/);
  assert.match(withTools, /offer to save it with save_company_knowledge/);

  // A surface without the tools is not told about a knowledge base it cannot open.
  const without = buildMilaSystemInstruction({ tools: ["delegate_to_hermes"], knowledgeIndex: knowledgePromptIndex() });
  assert.equal(without.includes("search_company_knowledge"), false);
  assert.equal(without.includes("products-and-prices"), false);

  // A reader who cannot write is not offered dictation.
  const readOnly = buildMilaSystemInstruction({ tools: ["search_company_knowledge"], knowledgeIndex: knowledgePromptIndex() });
  assert.equal(readOnly.includes("offer to save it"), false);
});

test("the index cannot push the prompt past the context it shares", () => {
  const instruction = buildMilaSystemInstruction({
    tools: MILA_TOOLS.map((tool) => tool.name),
    knowledgeIndex: "x".repeat(5000),
    agentContext: "y".repeat(AGENT_CONTEXT_LIMIT),
  });
  // The index is clamped where it is inserted, so a runaway page list cannot
  // crowd out the workspace facts the way the playbook already does.
  assert.ok(instruction.includes("x".repeat(900)));
  assert.equal(instruction.includes("x".repeat(901)), false);
});
