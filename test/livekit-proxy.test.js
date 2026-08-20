import assert from "node:assert/strict";
import { test } from "node:test";

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
