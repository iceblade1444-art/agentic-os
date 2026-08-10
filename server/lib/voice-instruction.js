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
// What every shipped build of the mobile app declares today. When a newer build
// sends its own list, this stops being used for that caller.
export const MOBILE_BASELINE_TOOLS = ["delegate_to_hermes"];

function requestedTools(value) {
  if (!Array.isArray(value)) return MOBILE_BASELINE_TOOLS;
  const names = value
    .map((item) => (typeof item === "string" ? item : item?.name))
    .filter((name) => KNOWN_TOOLS.has(name));
  // An empty or entirely unrecognised list means the caller told us nothing
  // usable, which is not the same as "no tools at all".
  return names.length ? [...new Set(names)] : MOBILE_BASELINE_TOOLS;
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
