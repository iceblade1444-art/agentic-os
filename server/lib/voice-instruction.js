// Serves the browser's own voice prompt to the LiveKit voice agent.
//
// The prompt used to be written twice — once in the browser, once in the agent's
// Python — and the copies drifted until a phone call and a browser call were
// noticeably different assistants. Both now compose from assets/js/mila-prompt.js.
//
// The prompt is shared, and for the channels named in SERVER_OWNED_CHANNELS so
// is the tool list: they ask "what may this person do here" and are told,
// instead of announcing a list of their own. That is the fix for the phone,
// which kept its list in Dart and therefore never saw a tool added on the
// server — the turnstile, the staff directory and the order board all existed
// for weeks without reaching it.
//
// The LiveKit agent still announces its own set, because its tools are Python
// functions it registers itself; a list it did not choose would be a promise it
// cannot keep. A caller that says nothing gets the conservative baseline.
import { buildMilaSystemInstruction, normalizeMilaPreferences } from "../../assets/js/mila-prompt.js";
import { MILA_TOOLS } from "../../assets/js/mila-tools.js";
import { knowledgePromptIndex } from "../../assets/js/knowledge-pages.js";

import { channelToolNames } from "./mila-audience.js";
import { sharedAgentContext } from "./onboarding.js";

const LANGUAGES = new Set(["ru-RU", "uz-UZ", "en-US", "auto"]);
const KNOWN_TOOLS = new Set(MILA_TOOLS.map((tool) => tool.name));
// The only caller of this endpoint is the LiveKit phone agent, and this mirrors
// the @function_tool set it registers in voice-agent/agent.py. It is a fallback
// for older agent builds: a build that sends its own list is believed instead,
// so this list stops mattering the moment the agent is updated.
//
// Keep it in step with that file. Too narrow strips the agent of ERP rules it
// genuinely needs; too wide puts back the promises this gating exists to stop.
export const LIVEKIT_BASELINE_TOOLS = [
  "get_finished_goods_stock", "get_erp_business_context", "get_system_status",
  "list_kanban_tasks", "create_kanban_task", "delegate_to_hermes",
  "search_obsidian_notes", "read_obsidian_note", "write_obsidian_note", "ask_claude_code",
];

// Channels whose tool list the server owns. The phone used to keep its own
// copy in Dart, which is why tools added on the server never reached it: naming
// a channel here asks for that person's list instead of announcing one.
const SERVER_OWNED_CHANNELS = new Set(["mobile", "telegram", "messenger"]);

function requestedTools(value, user, channel) {
  if (SERVER_OWNED_CHANNELS.has(channel)) return channelToolNames(user, channel);
  if (!Array.isArray(value)) return LIVEKIT_BASELINE_TOOLS;
  const names = value
    .map((item) => (typeof item === "string" ? item : item?.name))
    .filter((name) => KNOWN_TOOLS.has(name));
  // An empty or entirely unrecognised list means the caller told us nothing
  // usable, which is not the same as "no tools at all".
  return names.length ? [...new Set(names)] : LIVEKIT_BASELINE_TOOLS;
}

// A service credential is not a person, but the master token resolves to the
// owner — so the voice agent, which presents it, was handed the owner's private
// profile and the company day journal and then carried them into *every* call,
// including a Member's. The model is asked not to repeat such things, but the
// audience rule this codebase keeps returning to says the quiet part plainly:
// the only reliable way not to say something in a room is not to know it there.
//
// So a caller that has not proved whose call this is gets the shared audience —
// the company's own context, which colleagues share anyway, and none of the
// private half. Naming the person (an agent token) restores it, because then
// the context belongs to whoever is actually on the line.
export function voiceInstruction(user, requested = {}) {
  const audience = requested.identified === false ? "shared" : "owner";
  const language = LANGUAGES.has(requested.language) ? requested.language : "auto";
  // Unknown or hostile values fall back to defaults inside normalizeMilaPreferences,
  // so a caller cannot inject prompt text through a preference field.
  const preferences = normalizeMilaPreferences(requested.preferences || {});
  const channel = String(requested.channel || "").slice(0, 20);
  const tools = requestedTools(requested.tools, user, channel);
  const instruction = buildMilaSystemInstruction({
    language,
    preferences,
    agentContext: sharedAgentContext(user, undefined, { audience }),
    mode: requested.mode === "text" ? "text" : "voice",
    tools,
    knowledgeIndex: knowledgePromptIndex(),
  });
  return { instruction, language, preferences, tools, channel: channel || "", audience };
}
