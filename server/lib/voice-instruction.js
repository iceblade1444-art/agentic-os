// Serves the browser's own voice prompt to the LiveKit voice agent.
//
// The prompt used to be written twice — once in the browser, once in the agent's
// Python — and the copies drifted until a phone call and a browser call were
// noticeably different assistants. Both now compose from assets/js/mila-prompt.js.
import { buildMilaSystemInstruction, normalizeMilaPreferences } from "../../assets/js/mila-prompt.js";

import { sharedAgentContext } from "./onboarding.js";

const LANGUAGES = new Set(["ru-RU", "uz-UZ", "en-US", "auto"]);

export function voiceInstruction(user, requested = {}) {
  const language = LANGUAGES.has(requested.language) ? requested.language : "auto";
  // Unknown or hostile values fall back to defaults inside normalizeMilaPreferences,
  // so a caller cannot inject prompt text through a preference field.
  const preferences = normalizeMilaPreferences(requested.preferences || {});
  const instruction = buildMilaSystemInstruction({
    language,
    preferences,
    agentContext: sharedAgentContext(user),
    mode: requested.mode === "text" ? "text" : "voice",
  });
  return { instruction, language, preferences };
}
