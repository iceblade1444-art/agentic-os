import crypto from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "../server/config.js";
import { hasLiveKitAccess, isLiveKitSignalPath, mountLiveKitProxy } from "../server/lib/livekit-proxy.js";

test("LiveKit proxy accepts only its signaling endpoint", () => {
  assert.equal(isLiveKitSignalPath("/rtc"), true);
  assert.equal(isLiveKitSignalPath("/rtc?access_token=redacted"), true);
  assert.equal(isLiveKitSignalPath("/rtc/validate"), true);
  assert.equal(isLiveKitSignalPath("/mila"), false);
  assert.equal(isLiveKitSignalPath("/hermes/rtc"), false);
});

test("the transport is for signed-in callers, not the open internet", () => {
  assert.equal(hasLiveKitAccess({ headers: {} }, () => false), false);
  assert.equal(hasLiveKitAccess({ headers: {} }, () => true), true);
});

// The proxy is mounted ahead of requireAuth, so a regression here silently
// republishes the LiveKit signalling server under our hostname.
test("an unauthenticated request is refused instead of proxied", () => {
  const { handler, upgrade, proxied } = mountedProxy(() => false);

  const answered = [];
  handler({ url: "/rtc", originalUrl: "/rtc", headers: {} }, {
    status(code) { this.statusCode = code; return this; },
    json(body) { answered.push({ status: this.statusCode, body }); return this; },
  }, () => answered.push("next"));

  assert.deepEqual(answered, [{ status: 401, body: { error: "unauthorized" } }]);
  assert.equal(proxied.web, 0, "nothing may reach LiveKit before authentication");

  const socket = fakeSocket();
  upgrade({ url: "/rtc", headers: {} }, socket, Buffer.alloc(0));
  assert.match(socket.written.join(""), /401 Unauthorized/);
  assert.equal(socket.destroyed, true);
  assert.equal(proxied.ws, 0);
});

test("an authenticated caller still reaches the transport", () => {
  const { handler, upgrade, proxied } = mountedProxy(() => true);

  handler({ url: "/rtc", originalUrl: "/rtc", headers: {} }, {
    status() { throw new Error("an authenticated call must not be refused"); },
  }, () => { throw new Error("the signalling path must not fall through"); });
  assert.equal(proxied.web, 1);

  upgrade({ url: "/rtc", headers: {} }, fakeSocket(), Buffer.alloc(0));
  assert.equal(proxied.ws, 1);
});

test("paths that are not the signalling endpoint are left alone", () => {
  const { handler, upgrade, proxied } = mountedProxy(() => false);

  let nexted = false;
  handler({ url: "/api/health", originalUrl: "/api/health", headers: {} }, {
    status() { throw new Error("unrelated routes must not be answered here"); },
  }, () => { nexted = true; });

  assert.equal(nexted, true, "unrelated requests continue down the stack");
  const socket = fakeSocket();
  upgrade({ url: "/api/health", headers: {} }, socket, Buffer.alloc(0));
  assert.equal(socket.destroyed, false, "another upgrade handler may own this path");
  assert.deepEqual(proxied, { web: 0, ws: 0 });
});

function mountedProxy(authed) {
  const proxied = { web: 0, ws: 0 };
  let handler = null;
  let upgrade = null;
  const app = { use(fn) { handler = fn; } };
  const server = { on(event, fn) { if (event === "upgrade") upgrade = fn; } };

  // isAuthed reads the real session store; the proxy takes it as a parameter so
  // the refusal path can be proven without minting a session.
  mountLiveKitProxy(app, server, {
    web() { proxied.web += 1; },
    ws() { proxied.ws += 1; },
  }, authed);

  return { handler, upgrade, proxied };
}

function fakeSocket() {
  return {
    written: [],
    destroyed: false,
    write(chunk) { this.written.push(String(chunk)); },
    destroy() { this.destroyed = true; },
  };
}

/* ------------------------------------------------------------------
   The phone could not get through this gate, and that is how MILA Live
   stopped working on Android.

   The gate arrived in d29dc93 ("Stage 0: the security work reaches
   production") and asks one question: is this a signed-in console session?
   The phone never is. It authenticates against the MILA backend — a separate
   service with its own accounts — and arrives holding a LiveKit room token
   and nothing else. So it was refused here, before LiveKit ever saw it, and
   the app reported {"error":"unauthorized"} which reads exactly like LiveKit
   rejecting the token it had just been given.

   The same commit broke the runtime health probe for the same reason: a
   caller that legitimately cannot present a session, turned away by a new
   check that assumed everyone can.
   ------------------------------------------------------------------ */

const SECRET = "test-secret-please-ignore";
const KEY = "APItestkey";

function roomToken(claims = {}, secret = SECRET) {
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({
    iss: KEY, sub: "phone", exp: now + 900,
    video: { room: "mila-1", roomJoin: true },
    ...claims,
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const req = (token, { header = false } = {}) => ({
  url: header ? "/rtc" : `/rtc?access_token=${token}`,
  headers: header ? { authorization: `Bearer ${token}` } : {},
});

const noSession = () => false;

test("a phone holding a valid room token is let through", () => {
  config.livekitApiSecret = SECRET;
  config.livekitApiKey = KEY;
  assert.equal(hasLiveKitAccess(req(roomToken()), noSession), true);
  // The header form too: some clients send it that way.
  assert.equal(hasLiveKitAccess(req(roomToken(), { header: true }), noSession), true);
});

test("a token signed with the wrong secret is not a token", () => {
  config.livekitApiSecret = SECRET;
  config.livekitApiKey = KEY;
  assert.equal(hasLiveKitAccess(req(roomToken({}, "some-other-secret")), noSession), false);
});

test("an expired token is refused, as LiveKit would refuse it", () => {
  config.livekitApiSecret = SECRET;
  config.livekitApiKey = KEY;
  const past = Math.floor(Date.now() / 1000) - 10;
  assert.equal(hasLiveKitAccess(req(roomToken({ exp: past })), noSession), false);
  // And a token with no expiry at all is not eternal, it is malformed.
  assert.equal(hasLiveKitAccess(req(roomToken({ exp: undefined })), noSession), false);
});

test("a token minted by a different installation is refused", () => {
  config.livekitApiSecret = SECRET;
  config.livekitApiKey = KEY;
  assert.equal(hasLiveKitAccess(req(roomToken({ iss: "APIsomeoneelse" })), noSession), false);
});

test("a correctly signed token that does not join a room is refused", () => {
  // The secret signs more than room tokens. Only one kind belongs here.
  config.livekitApiSecret = SECRET;
  config.livekitApiKey = KEY;
  assert.equal(hasLiveKitAccess(req(roomToken({ video: { roomList: true } })), noSession), false);
  assert.equal(hasLiveKitAccess(req(roomToken({ video: { roomJoin: false, room: "x" } })), noSession), false);
});

test("rubbish in the query does not throw and does not pass", () => {
  config.livekitApiSecret = SECRET;
  config.livekitApiKey = KEY;
  for (const junk of ["", "not.a.jwt", "a.b", "....", "%%%"]) {
    assert.equal(hasLiveKitAccess(req(junk), noSession), false, `${JSON.stringify(junk)} passed`);
  }
  assert.equal(hasLiveKitAccess({ url: "/rtc", headers: {} }, noSession), false);
});

test("without a configured secret the gate stays session-only", () => {
  // A missing secret must never be the reason something is let through.
  config.livekitApiSecret = "";
  assert.equal(hasLiveKitAccess(req(roomToken()), noSession), false);
  assert.equal(hasLiveKitAccess(req(roomToken()), () => true), true, "a session still works");
});

test("a console session still needs no token at all", () => {
  config.livekitApiSecret = SECRET;
  assert.equal(hasLiveKitAccess({ url: "/rtc", headers: {} }, () => true), true);
});
