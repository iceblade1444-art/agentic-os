// A meeting transcript in, a working protocol out.
//
// The transcript comes from our own Speech Studio, so the audio never leaves
// the company's server — which is the whole reason a factory can record its
// planning meetings at all. This module turns the raw text into the three
// things a meeting actually produces: a short summary, the decisions taken,
// and the assignments with owners and dates. The protocol is saved into the
// vault where operators work, and the day journal records that the meeting
// happened; the model's JSON is validated field by field, because a protocol
// with invented assignees is worse than no protocol.

import { db } from "../store.js";
import { journal } from "./journal.js";
import { knowledge } from "./knowledge.js";
import { milaGeminiChat } from "./mila.js";

const MAX_TRANSCRIPT = 60000;
const clean = (value, max) => String(value ?? "").trim().slice(0, max);

const MINUTES_PROMPT = [
  "You turn a raw meeting transcript into minutes. The transcript is speech-to-text output: expect recognition noise, fillers and missing punctuation.",
  "Reply with ONLY a JSON object, no prose and no code fences:",
  '{"title":"...","summary":"...","decisions":["..."],"actions":[{"title":"...","owner":"...","due":"YYYY-MM-DD or empty"}],"open_questions":["..."]}',
  "Rules: write in the language the meeting was held in. Put into decisions only what was actually decided, not discussed. An action needs a doer — if nobody was named, leave owner empty rather than guessing. Dates only if a date was said. Keep the summary under 5 sentences.",
].join("\n");

export function createMeetingMinutes(options = {}) {
  const chat = options.chat || milaGeminiChat;
  const milaConfig = options.milaConfig || (() => db.integrations.byProvider("mila")?.config || {});
  const library = options.knowledge || knowledge;
  const journalStore = options.journal || journal;

  function parseMinutes(text) {
    const raw = clean(text, 20000).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const value = JSON.parse(raw);
    return {
      title: clean(value.title, 160) || "Совещание",
      summary: clean(value.summary, 2000),
      decisions: (Array.isArray(value.decisions) ? value.decisions : []).map((item) => clean(item, 400)).filter(Boolean).slice(0, 20),
      actions: (Array.isArray(value.actions) ? value.actions : [])
        .map((item) => ({
          title: clean(item?.title, 300),
          owner: clean(item?.owner, 80),
          due: /^\d{4}-\d{2}-\d{2}$/.test(clean(item?.due, 10)) ? clean(item.due, 10) : "",
        }))
        .filter((item) => item.title)
        .slice(0, 30),
      openQuestions: (Array.isArray(value.open_questions) ? value.open_questions : []).map((item) => clean(item, 400)).filter(Boolean).slice(0, 10),
    };
  }

  function protocolMarkdown(minutes, meta) {
    return [
      `# ${minutes.title}`,
      "",
      `Дата: ${meta.date}. Протокол составлен MILA по записи (Speech Studio).`,
      "",
      minutes.summary,
      "",
      "## Решения",
      ...(minutes.decisions.length ? minutes.decisions.map((item) => `- ${item}`) : ["- (решений не зафиксировано)"]),
      "",
      "## Поручения",
      ...(minutes.actions.length
        ? minutes.actions.map((item) => `- [ ] ${item.title}${item.owner ? ` — ${item.owner}` : ""}${item.due ? ` (до ${item.due})` : ""}`)
        : ["- (поручений не зафиксировано)"]),
      ...(minutes.openQuestions.length ? ["", "## Открытые вопросы", ...minutes.openQuestions.map((item) => `- ❔ ${item}`)] : []),
      "",
    ].join("\n");
  }

  async function minutes(transcript, { actor = "оператор", timezone = "Asia/Tashkent" } = {}) {
    const text = clean(transcript, MAX_TRANSCRIPT);
    if (text.length < 40) {
      throw Object.assign(new Error("Transcript is too short to be a meeting"), { status: 400 });
    }
    const cfg = milaConfig();
    if (!cfg.baseUrl) throw Object.assign(new Error("MILA backend is not configured"), { status: 503 });

    const result = await chat(cfg, "Meeting minutes", {
      messages: [{ role: "user", content: text }],
      systemPrompt: MINUTES_PROMPT,
    });
    let parsed;
    try {
      parsed = parseMinutes(result?.text);
    } catch {
      throw Object.assign(new Error("MILA could not structure this transcript — try again"), { status: 502 });
    }

    const date = new Date().toLocaleDateString("sv-SE", { timeZone: timezone });
    const time = new Date().toLocaleTimeString("sv-SE", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).replace(":", "");
    const notePath = `Agentic OS/Meetings/${date} ${time} — ${parsed.title.replaceAll("/", "-").slice(0, 60)}.md`;

    // Saving is best-effort in one direction only: a protocol the operator can
    // see but that failed to reach the vault is still a protocol; the reverse —
    // "saved" reported without a file — is not allowed to happen.
    let saved = "";
    try {
      await library.create(notePath, protocolMarkdown(parsed, { date }), { actor, source: "meeting-minutes" });
      saved = notePath;
    } catch { /* vault unavailable — the caller still gets the minutes */ }
    Promise.resolve(
      journalStore.append({ actor, kind: "meeting", title: `Протокол: ${parsed.title}`, detail: `${parsed.decisions.length} решений, ${parsed.actions.length} поручений` }),
    ).catch(() => {});

    return { ...parsed, savedTo: saved, date };
  }

  return { minutes };
}

export const meetingMinutes = createMeetingMinutes();
