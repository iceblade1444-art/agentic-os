// The company knowledge base: what pages exist and what each one holds.
//
// Shared by the browser, which puts the index into MILA's prompt, and the
// server, which stores the pages in the vault. Deliberately free of browser and
// server APIs so both runtimes import it directly — the same reason
// mila-prompt.js is written this way.
//
// The index is what the prompt carries. The pages themselves cannot fit: the
// whole shared context is 9000 characters and the marketing playbook already
// overruns it, so a page added to the prompt would silently evict another.

export const KNOWLEDGE_PAGES = [
  {
    slug: "products-and-prices",
    title: "Продукция и цены",
    hint: "прайс, минимальная партия, отсрочки, скидки, составы тканей, размерные сетки, уход",
    sections: ["Прайс и условия", "Минимальная партия и отсрочки", "Составы тканей", "Размерные сетки", "Уход за изделиями"],
  },
  {
    slug: "who-does-what",
    title: "Кто за что отвечает",
    hint: "сотрудники, цеха, телефоны, к кому идти с каким вопросом",
    sections: ["Руководство", "Производство и цеха", "Склад и отгрузки", "Продажи и клиенты", "К кому с каким вопросом"],
  },
  {
    slug: "export-by-country",
    title: "Экспорт по странам",
    hint: "документы, сроки, требования и особенности каждого рынка",
    sections: ["Общие правила экспорта", "Казахстан", "Россия", "Киргизия", "Прочие рынки"],
  },
  {
    slug: "customer-questions",
    title: "Частые вопросы клиентов",
    hint: "готовые ответы оптовикам и регламенты общения",
    sections: ["Вопросы о цене и партии", "Вопросы о качестве и тканях", "Вопросы о сроках и доставке", "Что отвечать, если не знаем"],
  },
];

export const KNOWLEDGE_PAGE_SLUGS = KNOWLEDGE_PAGES.map((page) => page.slug);

// One line per page, bounded so it can never crowd out the workspace facts it
// sits beside.
export function knowledgePromptIndex(limit = 700) {
  const out = KNOWLEDGE_PAGES.map((page) => `- ${page.slug} — ${page.title}: ${page.hint}`).join("\n");
  return out.length > limit ? `${out.slice(0, limit - 1)}…` : out;
}

export function knowledgePageTemplate(page) {
  return `# ${page.title}

> ${page.hint}
>
> Эту страницу читает MILA, когда её спрашивают. Пишите фактами: короткой строкой, которую можно процитировать клиенту. Чего не знаете — оставьте «❔», она спросит вместо того, чтобы выдумать.

${page.sections.map((section) => `## ${section}\n\n❔\n`).join("\n")}`;
}
