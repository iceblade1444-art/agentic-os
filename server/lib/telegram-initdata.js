// Proving that a Mini App request really came from Telegram.
//
// A Mini App is a web page Telegram opens in a container, and the only thing
// distinguishing it from any other page pointed at this URL is `initData`: a
// query string Telegram signs with a key derived from the bot token. Verifying
// that signature is the whole of the authentication, so it is written here on
// its own, as pure functions over strings, and tested against forged, replayed
// and truncated payloads rather than only against the happy path.
//
// The signature proves Telegram sent it and that nobody edited it. It does not
// say the person is allowed in — that is the link table's job, and it is a
// separate step in the route. A valid signature for a Telegram account nobody
// linked is a stranger with a genuine passport.

import crypto from "node:crypto";

// Telegram's own default is a day. Anything longer turns a leaked URL — and
// initData does travel in a URL fragment — into a standing credential.
export const MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * The string Telegram signed: every field except `hash` and `signature`,
 * sorted by key, as `key=value` lines.
 *
 * `signature` is Telegram's newer third-party ed25519 field and is excluded by
 * the same specification that adds it; including it makes every check fail.
 */
export function dataCheckString(params) {
  return [...params.entries()]
    .filter(([key]) => key !== "hash" && key !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

const hmac = (key, message) => crypto.createHmac("sha256", key).update(message).digest();

/**
 * Verify one initData string.
 *
 * Returns `{ ok: false, reason }` rather than throwing, because every failure
 * here is an ordinary answer to give a caller and none of them should read
 * differently to an attacker.
 */
export function verifyInitData(initData, botToken, options = {}) {
  const maxAge = options.maxAgeSeconds ?? MAX_AGE_SECONDS;
  const now = options.now ?? Date.now();
  if (!botToken) return { ok: false, reason: "not_configured" };
  if (typeof initData !== "string" || !initData || initData.length > 8192) {
    return { ok: false, reason: "malformed" };
  }

  let params;
  try { params = new URLSearchParams(initData); } catch { return { ok: false, reason: "malformed" }; }

  const provided = params.get("hash") || "";
  if (!/^[0-9a-f]{64}$/i.test(provided)) return { ok: false, reason: "malformed" };

  // secret_key = HMAC_SHA256(bot_token) keyed with the literal "WebAppData",
  // then the payload is signed with that. The two are easy to transpose and
  // transposing them verifies nothing.
  const secret = hmac("WebAppData", botToken);
  const expected = hmac(secret, dataCheckString(params)).toString("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided.toLowerCase(), "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: "malformed" };
  const ageSeconds = Math.floor(now / 1000) - authDate;
  // A future timestamp is as wrong as an ancient one; a small tolerance covers
  // ordinary clock skew between Telegram and this host.
  if (ageSeconds > maxAge || ageSeconds < -300) return { ok: false, reason: "expired" };

  let user = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch { return { ok: false, reason: "malformed" }; }
  if (!user || typeof user.id !== "number" || !Number.isSafeInteger(user.id)) {
    return { ok: false, reason: "no_user" };
  }

  return {
    ok: true,
    user: {
      id: user.id,
      username: String(user.username || "").slice(0, 64),
      firstName: String(user.first_name || "").slice(0, 64),
      languageCode: String(user.language_code || "").slice(0, 16).toLowerCase(),
    },
    authDate,
  };
}

/** ru-RU / en-US / uz-UZ from Telegram's two-letter code. */
export function localeFromTelegram(languageCode) {
  const code = String(languageCode || "").toLowerCase();
  if (code.startsWith("uz")) return "uz-UZ";
  if (code.startsWith("en")) return "en-US";
  return "ru-RU";
}
