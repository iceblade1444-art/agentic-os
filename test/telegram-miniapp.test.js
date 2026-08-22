// The Mini App is an authentication surface, so most of this is about what it
// refuses.
//
// Telegram signs `initData` with a key derived from the bot token, and that
// signature is the entire proof that a request came from Telegram at all. Get
// the HMAC wrong in either direction — key and message transposed, `signature`
// left in the checked string, the comparison done with `===` — and the door is
// either permanently shut or permanently open. So the forged, replayed and
// truncated cases are tested first, and the happy path last.
//
// The signature says who is asking. It never says they are allowed in: that is
// the link table, the same one that has always decided who the bot may write
// to, and it is a separate check.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import {
  dataCheckString, localeFromTelegram, MAX_AGE_SECONDS, verifyInitData,
} from "../server/lib/telegram-initdata.js";
import { miniAppHtml, telegramAuthHandler } from "../server/routes/telegram-miniapp.js";

const BOT_TOKEN = "7654321:AAH-test-token-not-a-real-one";
const TG_USER = { id: 777, username: "bakhadyr", first_name: "Бахадыр", language_code: "ru" };
const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };

// Signs exactly the way Telegram does, so a passing test proves the real thing
// verifies rather than proving our own inverse function agrees with itself.
function signInitData(fields, token = BOT_TOKEN) {
  const params = new URLSearchParams(fields);
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheckString(params)).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

const freshInitData = (over = {}) => signInitData({
  query_id: "AAH123",
  user: JSON.stringify(TG_USER),
  auth_date: String(Math.floor(Date.now() / 1000)),
  ...over,
});

/* ---------------- what it refuses ---------------- */

test("an unsigned or forged payload is not a session", () => {
  const good = freshInitData();
  assert.equal(verifyInitData(good, BOT_TOKEN).ok, true, "sanity: the fixture is well-formed");

  // Signed with somebody else's bot.
  const otherBot = signInitData({ user: JSON.stringify(TG_USER), auth_date: String(Math.floor(Date.now() / 1000)) }, "1111:different");
  assert.deepEqual(verifyInitData(otherBot, BOT_TOKEN), { ok: false, reason: "bad_signature" });

  // Edited after signing — the classic: keep the hash, change who you are.
  const swapped = good.replace(encodeURIComponent('"id":777'), encodeURIComponent('"id":999'));
  assert.notEqual(swapped, good, "sanity: the fixture really was edited");
  assert.equal(verifyInitData(swapped, BOT_TOKEN).ok, false);

  for (const junk of ["", "hash=deadbeef", "user=%7B%7D&hash=" + "0".repeat(64), null, undefined, 42]) {
    assert.equal(verifyInitData(junk, BOT_TOKEN).ok, false, `accepted ${String(junk).slice(0, 24)}`);
  }
  // No token, no verification — never "everything passes".
  assert.deepEqual(verifyInitData(good, ""), { ok: false, reason: "not_configured" });
});

test("a stale payload stops working", () => {
  // initData travels in a URL fragment. Without an age bound, one that leaks
  // into a screenshot or a log is a standing credential.
  const old = Math.floor(Date.now() / 1000) - MAX_AGE_SECONDS - 60;
  assert.deepEqual(verifyInitData(freshInitData({ auth_date: String(old) }), BOT_TOKEN).ok, false);
  const stillGood = Math.floor(Date.now() / 1000) - MAX_AGE_SECONDS + 600;
  assert.equal(verifyInitData(freshInitData({ auth_date: String(stillGood) }), BOT_TOKEN).ok, true);
  // A timestamp from the future is as wrong as an ancient one.
  const future = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(verifyInitData(freshInitData({ auth_date: String(future) }), BOT_TOKEN).ok, false);
  // Ordinary clock skew is not an attack.
  const skewed = Math.floor(Date.now() / 1000) + 60;
  assert.equal(verifyInitData(freshInitData({ auth_date: String(skewed) }), BOT_TOKEN).ok, true);
});

test("the checked string is the one Telegram actually signed", () => {
  // `signature` is Telegram's newer ed25519 field, and the same specification
  // that adds it excludes it from the HMAC. Including it fails every check
  // from a modern client — and only from a modern client, so it would look
  // like an intermittent bug.
  const params = new URLSearchParams({ b: "2", hash: "x", a: "1", signature: "sig" });
  assert.equal(dataCheckString(params), "a=1\nb=2");

  const withSignature = signInitData({
    user: JSON.stringify(TG_USER),
    auth_date: String(Math.floor(Date.now() / 1000)),
    signature: "ed25519-thing",
  });
  assert.equal(verifyInitData(withSignature, BOT_TOKEN).ok, true);
});

test("a payload that verifies but names nobody is refused", () => {
  const noUser = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)) });
  assert.deepEqual(verifyInitData(noUser, BOT_TOKEN).reason, "no_user");
});

/* ---------------- who it lets in ---------------- */

function handler(over = {}) {
  const calls = { unlinked: [], sessions: [] };
  const res = {
    statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
  // `telegram` is merged, not replaced: an override that only supplies
  // accountForChat must still get a working unlink, or the test fails on its
  // own stub instead of on the code.
  const { telegram: telegramOver, ...rest } = over;
  const fn = telegramAuthHandler({
    botToken: BOT_TOKEN,
    sessions: { create: (userId, opts) => { calls.sessions.push({ userId, ...opts }); return { id: "sess_1" }; } },
    users: { get: () => null },
    creatorUser: () => OWNER,
    ...rest,
    telegram: {
      accountForChat: (chatId) => (chatId === TG_USER.id ? "creator" : null),
      unlink: (id) => calls.unlinked.push(id),
      token: () => BOT_TOKEN,
      ...telegramOver,
    },
  });
  return { fn, res, calls };
}

test("a linked Telegram account gets an ordinary session", async () => {
  const { fn, res, calls } = handler();
  await fn({ body: { initData: freshInitData() }, secure: true }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.user.id, "creator");
  assert.equal(res.body.locale, "ru-RU", "the client's language is a reasonable first guess");
  // The same session a browser login issues — same kind, same week.
  assert.equal(calls.sessions.length, 1);
  assert.equal(calls.sessions[0].kind, "web");
  assert.match(calls.sessions[0].label, /^Telegram @bakhadyr$/);
  assert.match(res.headers["Set-Cookie"], /HttpOnly/);
  assert.match(res.headers["Set-Cookie"], /SameSite=Lax/);
});

test("a genuine Telegram account nobody linked is a stranger", async () => {
  // The signature is real. That is not the same as being allowed in, and this
  // is the distinction the whole surface rests on.
  //
  // The user store is a tripwire, not a stub: if the link check is ever removed
  // the request falls through to a lookup for a null account, which happens to
  // 403 as well — so a test that only checks the status code would keep passing
  // over a missing gate.
  let lookedUp = false;
  const { fn, res, calls } = handler({
    telegram: { accountForChat: () => null, unlink: () => {} },
    users: { get: () => { lookedUp = true; return null; } },
  });
  await fn({ body: { initData: freshInitData() } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "not_linked");
  assert.equal(lookedUp, false, "an unlinked account must be refused before anything is looked up");
  assert.equal(calls.sessions.length, 0, "no session for an unlinked account");
  assert.equal(res.headers["Set-Cookie"], undefined);
});

test("a link whose account is gone is dropped, not honoured", async () => {
  const { fn, res, calls } = handler({
    telegram: { accountForChat: () => "usr_gone" },
    users: { get: () => null },
  });
  await fn({ body: { initData: freshInitData() } }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(calls.unlinked, ["usr_gone"]);
  assert.equal(calls.sessions.length, 0);
});

test("a disabled account cannot come in through Telegram either", async () => {
  const { fn, res, calls } = handler({
    telegram: { accountForChat: () => "usr_2" },
    users: { get: () => ({ id: "usr_2", role: "Member", disabledAt: "2026-08-01T00:00:00Z" }) },
  });
  await fn({ body: { initData: freshInitData() } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.sessions.length, 0);
});

test("a forged payload never reaches the link table", async () => {
  let asked = false;
  const { fn, res, calls } = handler({
    telegram: { accountForChat: () => { asked = true; return "creator"; } },
  });
  await fn({ body: { initData: "user=%7B%22id%22%3A777%7D&auth_date=1&hash=" + "a".repeat(64) } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(asked, false, "the signature is checked before anything is looked up");
  assert.equal(calls.sessions.length, 0);
});

test("with no bot token the door is shut, not open", async () => {
  const { fn, res } = handler({ botToken: "" });
  await fn({ body: { initData: freshInitData() } }, res);
  assert.equal(res.statusCode, 503);
});

/* ---------------- the container ---------------- */

test("the shell is framed only by Telegram, and only on /tg", () => {
  const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const html = miniAppHtml(index, "https://telegram.org/js/telegram-web-app.js");
  assert.match(html, /<script src="https:\/\/telegram\.org\/js\/telegram-web-app\.js"><\/script>/);
  assert.match(html, /<html data-surface="telegram"/);
  // The ordinary shell stays free of it: no third-party script for people who
  // are not in Telegram, and no second copy of index.html to keep in step.
  assert.doesNotMatch(index, /telegram-web-app\.js/);
  assert.doesNotMatch(index, /data-surface/);

  const route = fs.readFileSync(new URL("../server/routes/telegram-miniapp.js", import.meta.url), "utf8");
  assert.match(route, /res\.removeHeader\("X-Frame-Options"\)/, "DENY is why an embedded surface renders blank");
  assert.match(route, /frame-ancestors \$\{FRAME_ANCESTORS\}/);
  assert.match(route, /const FRAME_ANCESTORS = "https:\/\/web\.telegram\.org https:\/\/telegram\.org"/,
    "not a wildcard: only the origins that actually frame us");
  // The relaxation is scoped to this response. The global policy is untouched.
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  assert.match(server, /"frame-ancestors 'none'"/, "the site-wide policy still denies framing");
  assert.match(server, /res\.setHeader\("X-Frame-Options", "DENY"\)/);
});

test("the exchange is rate limited and outside the auth wall", () => {
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  assert.match(server, /app\.post\("\/api\/auth\/telegram", rateLimit\(\{ windowMs: 10 \* 60000, max: 20 \}\), telegramAuthHandler\(\)\)/);
  // Before requireWriteAccess, or the thing that signs you in would need you
  // to be signed in.
  assert.ok(server.indexOf("/api/auth/telegram") < server.indexOf('app.use("/api", requireWriteAccess)'));
});

test("the bridge does nothing outside Telegram", () => {
  const bridge = fs.readFileSync(new URL("../assets/js/telegram-miniapp.js", import.meta.url), "utf8");
  assert.match(bridge, /const webApp = \(\) => globalThis\.Telegram\?\.WebApp \|\| null;/);
  assert.match(bridge, /if \(!app\) return \(\) => \{\};/, "mounting is a no-op with no container");
  // Only real colours are taken from the client's theme; a blank one would
  // take the whole declaration down with it.
  assert.match(bridge, /if \(!\/\^#\[0-9a-f\]\{6\}\$\/i\.test\(String\(value \|\| ""\)\)\) continue;/);
  // The semantic colours stay ours: green-means-good is not something the
  // client's palette knows. Nor does the accent move — --primary is a fill, a
  // focus ring, an active rail item and a border here, while Telegram
  // guarantees button_color only against button_text_color. Its default blue
  // is 2.4:1 on white.
  // The THEME_MAP itself, not the prose around it — the comment explaining why
  // the accent is excluded necessarily names the thing it excludes.
  const map = bridge.slice(bridge.indexOf("const THEME_MAP"), bridge.indexOf("];", bridge.indexOf("const THEME_MAP")));
  for (const ours of ["--success", "--warning", "--error", "--primary", "--primary-ink"]) {
    assert.equal(map.includes(ours), false, `${ours} must not be overwritten by themeParams`);
  }
  assert.equal(map.includes("button_color"), false);
  assert.deepEqual(
    [...map.matchAll(/"(--[a-z0-9-]+)"/g)].map((m) => m[1]),
    ["--bg", "--surface", "--surface-2", "--text", "--text-3"],
    "grounds and text only",
  );
  // Light or dark is decided by the ground actually handed over, not by
  // colorScheme: a user-made theme can call itself light and send a dark
  // background, and the wrong token set puts light ink on it.
  assert.match(bridge, /const isLightGround = /);
  assert.match(bridge, /measured === null \? app\.colorScheme === "light" : measured/);
  assert.match(bridge, /viewportStableHeight/);
  assert.match(bridge, /BackButton/);
  assert.match(bridge, /MainButton/);
});

test("Telegram's language maps onto one the app speaks", () => {
  assert.equal(localeFromTelegram("uz"), "uz-UZ");
  assert.equal(localeFromTelegram("en-GB"), "en-US");
  assert.equal(localeFromTelegram("ru"), "ru-RU");
  assert.equal(localeFromTelegram(""), "ru-RU");
  assert.equal(localeFromTelegram(undefined), "ru-RU");
});
