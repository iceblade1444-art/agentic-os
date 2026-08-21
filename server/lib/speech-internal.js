// How anything in Agentic OS reaches the speech container.
//
// This lived inside the speech route, and the Telegram voice code re-typed it
// from memory — with the wrong header name. The service answered 401, the
// transcription "failed", and the chat said "не смогла разобрать голосовое"
// about audio it never got to hear. The test that was supposed to catch it
// asserted the same invented name, so it proved only that the guess was
// consistent with itself.
//
// One definition, imported by everyone who talks to that container.

export const SPEECH_URL = process.env.SPEECH_URL || "http://speech:4400";
const SPEECH_INTERNAL_SECRET = process.env.SPEECH_INTERNAL_SECRET || "";

// The secret is a parameter so this is testable without depending on whether a
// .env happens to sit next to the test run — that made the suite pass on a
// developer machine and fail on the server.
export function speechInternalHeaders(extra = {}, secret = SPEECH_INTERNAL_SECRET) {
  return secret ? { ...extra, "X-Internal-Secret": secret } : extra;
}

export function speechSecretConfigured(secret = SPEECH_INTERNAL_SECRET) {
  return !!secret;
}
