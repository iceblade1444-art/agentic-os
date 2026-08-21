// Voice notes in Telegram, transcribed by the speech container we already run.
//
// A factory owner walking the floor does not type. Until now a voice note sent
// to the bot produced nothing at all — the handler read message.text, found
// none, and returned in silence, which reads as "the bot is broken". Telegram
// hands over an OGG/Opus file; the speech service already turns audio into
// text for the browser and the phone, and it speaks Russian and Uzbek. So the
// note takes the same path a typed message does, and MILA never learns the
// difference.
//
// Nothing here throws: a transcription that fails must degrade into an honest
// sentence in the chat, never into a dead conversation.

const API = "https://api.telegram.org";
// Telegram's own ceiling for getFile downloads is 20 MB; a voice note is
// kilobytes, and anything larger is not a question to an assistant.
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 30000;

// Imported, not restated: this module once carried its own copy of the header
// name, spelled wrong, and the speech container answered 401 to every voice
// note the bot received.
import { SPEECH_URL, speechInternalHeaders } from "./speech-internal.js";

export { speechInternalHeaders };

// The audio Telegram may attach to a message, in the order we prefer it.
export function audioFileId(message = {}) {
  const item = message.voice || message.audio || message.video_note
    || (String(message.document?.mime_type || "").startsWith("audio/") ? message.document : null);
  return item?.file_id ? { fileId: String(item.file_id), seconds: Number(item.duration) || 0 } : null;
}

export function createVoiceTranscriber(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const speechUrl = options.speechUrl || SPEECH_URL;
  const secret = options.speechInternalSecret;

  // Two hops on Telegram's side: getFile resolves the path, then the file API
  // serves the bytes. Both need the bot token, which is why this takes it
  // rather than reading the store itself.
  async function download(token, fileId) {
    const info = await fetchImpl(`${API}/bot${token}/getFile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await info.json().catch(() => ({}));
    const filePath = json?.result?.file_path;
    if (!json?.ok || !filePath) throw new Error(json?.description || "Telegram did not return the file");
    const file = await fetchImpl(`${API}/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!file.ok) throw new Error(`file download failed: HTTP ${file.status}`);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > MAX_AUDIO_BYTES) throw new Error("audio is too large to transcribe");
    return { bytes, filePath: String(filePath) };
  }

  async function transcribe(token, fileId, { language = "" } = {}) {
    const { bytes, filePath } = await download(token, fileId);
    const name = filePath.split("/").pop() || "voice.oga";
    const form = new FormData();
    form.append("audio", new Blob([bytes]), name);
    if (language) form.append("language", language);
    const response = await fetchImpl(`${speechUrl}/stt`, {
      method: "POST",
      headers: speechInternalHeaders({}, secret),
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json?.error || `speech service HTTP ${response.status}`);
    const text = String(json.text || json.transcript || "").trim();
    if (!text) throw new Error("speech service returned no text");
    return text;
  }

  return { transcribe, download };
}

export const voiceTranscriber = createVoiceTranscriber();

// Speaking back.
//
// Answering a voice note with a wall of text is answering in a different
// language than the question was asked in: someone who spoke because their
// hands are busy cannot read the reply either. The speech service already has
// the voice — the same one the browser and the phone use — and ffmpeg to pack
// it as OGG/Opus, which is the only thing Telegram plays as a voice message
// rather than a file to download.
//
// The text always goes too. A voice message cannot be searched, forwarded as a
// quote, or read in a meeting, so it is an addition to the answer, never a
// replacement for it.

// Telegram plays a voice message up to an hour, but nobody listens to an
// assistant for four minutes; past this the text alone is the honest answer.
const MAX_SPOKEN_CHARS = 1200;

// What is worth speaking. Markdown read aloud is noise, and an answer that is
// mostly numbers in a table is easier to look at than to hear.
export function spokenForm(text = "") {
  return String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#]+/g, "")
    .replace(/^\s*[•\-–]\s*/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s*\n\s*/g, ". ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function createSpeaker(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const speechUrl = options.speechUrl || SPEECH_URL;
  const secret = options.speechInternalSecret;

  // Never throws: a reply that could not be spoken is still a reply, and the
  // caller has already sent the text.
  async function speak(text, { language = "ru" } = {}) {
    const spoken = spokenForm(text);
    if (!spoken || spoken.length > MAX_SPOKEN_CHARS) return null;
    try {
      const body = new URLSearchParams({ text: spoken, audio_format: "opus" });
      if (language) body.set("language", language);
      const response = await fetchImpl(`${speechUrl}/tts`, {
        method: "POST",
        headers: speechInternalHeaders({ "Content-Type": "application/x-www-form-urlencoded" }, secret),
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.length ? bytes : null;
    } catch {
      return null;
    }
  }

  return { speak, spokenForm };
}

export const speaker = createSpeaker();
