// The Hermes dashboard hands its session token only to a signed-in caller
// since the June-2026 hardening, so an anonymous GET / now answers 302 →
// /login and the bridge lost Kanban, Routines and Skills with it. These pin
// the way back in: log in once, carry the cookies, and say plainly what is
// missing when there are no credentials to log in with.
import assert from "node:assert/strict";
import test from "node:test";

import { __testing } from "../server/lib/hermes-kanban.js";

const PAGE = '<html><script>window.__HERMES_SESSION_TOKEN__ = "tok-123";</script></html>';

// A dashboard that redirects anonymous callers and serves the page once the
// session cookie is present — the shape production actually has.
function guardedDashboard({ onLogin } = {}) {
  const calls = [];
  return {
    calls,
    async request(pathname, options = {}) {
      calls.push({ pathname, method: options.method || "GET", cookie: options.headers?.Cookie || "" });
      if (pathname === "/auth/password-login") {
        if (onLogin) return onLogin(options);
        return { status: 200, text: '{"ok":true}', headers: { "set-cookie": ["hermes_session=abc; Path=/; HttpOnly", "hermes_provider=basic; Path=/"] } };
      }
      if (options.headers?.Cookie?.includes("hermes_session=abc")) return { status: 200, text: PAGE, headers: {} };
      return { status: 302, text: "", headers: { location: "/login?next=%2F" } };
    },
  };
}

test("a guarded dashboard is entered by signing in, then the token is read", async () => {
  __testing.reset();
  __testing.setCredentials({ username: "ops", password: "secret" });
  const dashboard = guardedDashboard();
  const token = await __testing.sessionToken(true, dashboard.request);
  assert.equal(token, "tok-123");
  assert.deepEqual(dashboard.calls.map((c) => `${c.method} ${c.pathname}`),
    ["GET /", "POST /auth/password-login", "GET /"]);
  // The retry carries the cookies the login handed back.
  assert.match(dashboard.calls[2].cookie, /hermes_session=abc/);
});

test("the login body is the contract the dashboard documents", async () => {
  __testing.reset();
  __testing.setCredentials({ username: "ops", password: "secret" });
  let seen = null;
  const dashboard = guardedDashboard({
    onLogin: (options) => {
      seen = JSON.parse(options.body);
      return { status: 200, text: '{"ok":true}', headers: { "set-cookie": ["hermes_session=abc"] } };
    },
  });
  await __testing.sessionToken(true, dashboard.request);
  assert.deepEqual(seen, { provider: "basic", username: "ops", password: "secret" });
});

test("without credentials the failure names what is missing", async () => {
  __testing.reset();
  __testing.setCredentials({ username: "", password: "" });
  const dashboard = guardedDashboard();
  await assert.rejects(
    () => __testing.sessionToken(true, dashboard.request),
    /HERMES_DASHBOARD_USERNAME and HERMES_DASHBOARD_PASSWORD/,
    "an operator must learn what to set, not that a token is 'unavailable'",
  );
});

test("a refused sign-in is reported, never retried into a rate limit", async () => {
  __testing.reset();
  __testing.setCredentials({ username: "ops", password: "wrong" });
  const dashboard = guardedDashboard({ onLogin: () => ({ status: 401, text: "", headers: {} }) });
  await assert.rejects(() => __testing.sessionToken(true, dashboard.request), /sign-in failed \(HTTP 401\)/);
  assert.equal(dashboard.calls.filter((c) => c.pathname === "/auth/password-login").length, 1);
});

test("a dashboard with no auth still works exactly as before", async () => {
  __testing.reset();
  __testing.setCredentials({ username: "", password: "" });
  const open = { async request() { return { status: 200, text: PAGE, headers: {} }; } };
  assert.equal(await __testing.sessionToken(true, open.request), "tok-123");
});
