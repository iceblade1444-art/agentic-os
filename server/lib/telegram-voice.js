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

// The speech route reads these straight from the environment rather than
// through config.js; matching it keeps one definition of the hop, not two.
const SPEECH_URL = process.env.SPEECH_URL || "http://speech:4400";
const SPEECH_INTERNAL_SECRET = process.env.SPEECH_INTERNAL_SECRET || "";

export function speechInternalHeaders(extra = {}, secret = SPEECH_INTERNAL_SECRET) {
  return secret ? { ...extra, "X-Speech-Secret": secret } : extra;
}

// The audio Telegram may attach to a message, in the order we prefer it.
export function audioFileId(message = {}) {
  const item = message.voice || message.audio || message.video_note
    || (String(message.document?.mime_type || "").startsWith("audio/") ? message.document : null);
  return item?.file_id ? { fileId: String(item.file_id), seconds: Number(item.duration) || 0 } : null;
}

export function createVoiceTranscriber(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const speechUrl = options.speechUrl || SPEECH_URL;
  const secret = options.speechInternalSecret ?? SPEECH_INTERNAL_SECRET;

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
