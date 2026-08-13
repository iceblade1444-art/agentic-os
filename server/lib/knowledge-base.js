// The company knowledge base MILA looks things up in.
//
// The prompt budget is 9000 characters and the marketing playbook alone already
// overruns it — roughly 40% of it never reaches an agent. So company knowledge
// cannot be carried in the prompt: adding a paragraph there does not add
// knowledge, it silently evicts another paragraph.
//
// Instead the prompt carries a short index of what exists, and MILA retrieves
// the page she needs. Storage stops being the limit — the whole vault is 2.4 MB
// against 13 GB free — and the knowledge can grow without costing anyone a
// truncated playbook.
//
// Scoped to one folder on purpose: the rest of the vault holds operator
// material, and this is the only part every employee may read.

import { KNOWLEDGE_PAGES, knowledgePageTemplate, knowledgePromptIndex } from "../../assets/js/knowledge-pages.js";

import { knowledge } from "./knowledge.js";

export { KNOWLEDGE_PAGES };
export const KNOWLEDGE_FOLDER = "Agentic OS/Knowledge";
const INDEX_BUDGET = 700;
const MAX_FACT = 1500;

const clean = (value, max) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);

const pagePath = (slug) => `${KNOWLEDGE_FOLDER}/${slug}.md`;
const pageBySlug = (slug) => KNOWLEDGE_PAGES.find((page) => page.slug === slug) || null;

export function createKnowledgeBase(options = {}) {
  const library = options.knowledge || knowledge;

  const inside = (path) => String(path || "").startsWith(`${KNOWLEDGE_FOLDER}/`);

  async function ensure(page, context) {
    try {
      return await library.read(pagePath(page.slug), context);
    } catch {
      return library.create(pagePath(page.slug), knowledgePageTemplate(page), context);
    }
  }

  /// One line per page: what it holds and when to open it. This is what the
  /// prompt carries instead of the content.
  const promptIndex = () => knowledgePromptIndex(INDEX_BUDGET);

  async function list(context = {}) {
    const notes = await library.list({ ...context, query: "" }).catch(() => []);
    const present = new Set(notes.filter((note) => inside(note.path)).map((note) => note.path));
    return KNOWLEDGE_PAGES.map((page) => ({
      slug: page.slug,
      title: page.title,
      hint: page.hint,
      path: pagePath(page.slug),
      exists: present.has(pagePath(page.slug)),
    }));
  }

  async function search(query, context = {}) {
    const result = await library.search(clean(query, 200), { ...context, limit: 20 });
    // The library searches the whole vault, which also holds operator material;
    // only the knowledge folder is company-wide reading.
    return (result.matches || [])
      .filter((match) => inside(match.path))
      .slice(0, 8)
      .map((match) => ({ path: match.path, title: match.title, snippet: clean(match.snippet, 600) }));
  }

  async function read(slug, context = {}) {
    const page = pageBySlug(clean(slug, 80));
    if (!page) throw Object.assign(new Error("Unknown knowledge page"), { status: 404 });
    const note = await ensure(page, context);
    return { slug: page.slug, title: page.title, path: pagePath(page.slug), content: note.content };
  }

  /// Dictation: one fact appended under a heading, stamped with who said it.
  /// Written as a bullet rather than prose so the page stays quotable.
  async function addFact(slug, { section = "", fact = "", author = "" } = {}, context = {}) {
    const page = pageBySlug(clean(slug, 80));
    if (!page) throw Object.assign(new Error("Unknown knowledge page"), { status: 404 });
    const text = clean(fact, MAX_FACT);
    if (text.length < 3) throw Object.assign(new Error("The fact is empty"), { status: 400 });
    await ensure(page, context);
    const heading = page.sections.includes(section) ? section : page.sections.at(-1);
    const stamp = new Date().toISOString().slice(0, 10);
    const line = `\n## ${heading}\n\n- ${text} — записал ${clean(author, 60) || "MILA"}, ${stamp}\n`;
    const note = await library.append(pagePath(page.slug), line, context);
    return { slug: page.slug, title: page.title, section: heading, fact: text, bytes: note.size };
  }

  return { promptIndex, list, search, read, addFact, pagePath };
}

export const knowledgeBase = createKnowledgeBase();
