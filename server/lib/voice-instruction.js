// Serves the browser's own voice prompt to the LiveKit voice agent.
//
// The prompt used to be written twice — once in the browser, once in the agent's
// Python — and the copies drifted until a phone call and a browser call were
// noticeably different assistants. Both now compose from assets/js/mila-prompt.js.
//
// The prompt is shared; the tools are not. The browser declares the full tool
// list, while the phone's live client declares its own much shorter one, so a
// caller states what it can actually run and the prompt describes only that.
// A client that says nothing gets the conservative baseline rather than a prompt
// promising thirteen tools it has no way to call.
import { buildMilaSystemInstruction, normalizeMilaPreferences } from "../../assets/js/mila-prompt.js";
import { MILA_TOOLS } from "../../assets/js/mila-tools.js";

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

function requestedTools(value) {
  if (!Array.isArray(value)) return LIVEKIT_BASELINE_TOOLS;
  const names = value
    .map((item) => (typeof item === "string" ? item : item?.name))
    .filter((name) => KNOWN_TOOLS.has(name));
  // An empty or entirely unrecognised list means the caller told us nothing
  // usable, which is not the same as "no tools at all".
  return names.length ? [...new Set(names)] : LIVEKIT_BASELINE_TOOLS;
}

export function voiceInstruction(user, requested = {}) {
  const language = LANGUAGES.has(requested.language) ? requested.language : "auto";
  // Unknown or hostile values fall back to defaults inside normalizeMilaPreferences,
  // so a caller cannot inject prompt text through a preference field.
  const preferences = normalizeMilaPreferences(requested.preferences || {});
  const tools = requestedTools(requested.tools);
  const instruction = buildMilaSystemInstruction({
    language,
    preferences,
    agentContext: sharedAgentContext(user),
    mode: requested.mode === "text" ? "text" : "voice",
    tools,
  });
  return { instruction, language, preferences, tools };
}
