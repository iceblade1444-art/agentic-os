// The happy path of signing in had no test at all: route coverage elsewhere
// greps server/index.js for the mounted middleware, which proves the route is
// wired and nothing about whether the handler runs. A ReferenceError on the
// success branch of loginHandler/mobileLoginHandler/logoutHandler therefore
// shipped green. These tests call the handlers for real, with a throwaway
// session store so they never write into the owner's device list.
import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "../server/config.js";
import { creatorUser, loginHandler, logoutHandler, mobileLoginHandler } from "../server/lib/auth.js";

function recorder() {
  const responses = [];
  const headers = {};
  return {
    responses,
    headers,
    res: {
      statusCode: 0,
      status(code) { this.statusCode = code; return this; },
      setHeader(name, value) { headers[name] = value; return this; },
      json(body) { responses.push({ status: this.statusCode || 200, body }); return this; },
    },
  };
}

function throwawayDeps(created = []) {
  return {
    sessions: {
      create(userId, meta) { created.push({ userId, ...meta }); return { id: "ses_test" }; },
      revoke() {},
    },
    commitAuthGroups: async () => {},
  };
}

async function withOwnerToken(run) {
  const previous = config.authToken;
  config.authToken = "test-owner-password";
  try { return await run(); } finally { config.authToken = previous; }
}

test("web login returns a session and sets the cookie", async () => {
  await withOwnerToken(async () => {
    const created = [];
    const { res, responses, headers } = recorder();
    await loginHandler({ body: { password: "test-owner-password" }, headers: {} }, res, throwawayDeps(created));

    assert.equal(responses.length, 1, "the handler must answer the request");
    assert.equal(responses[0].status, 200);
    assert.equal(responses[0].body.ok, true);
    assert.equal(responses[0].body.user.id, "creator");
    assert.equal(responses[0].body.capabilities.canAdmin, true);
    assert.match(headers["Set-Cookie"], /^aos_session=/);
    assert.match(headers["Set-Cookie"], /HttpOnly/);
    assert.equal(created.length, 1, "a tracked session is created for the device list");
    assert.equal(created[0].kind, "web");
  });
});

test("web login rejects a wrong password without creating a session", async () => {
  await withOwnerToken(async () => {
    const created = [];
    const { res, responses, headers } = recorder();
    await loginHandler({ body: { password: "wrong" }, headers: {} }, res, throwawayDeps(created));

    assert.equal(responses[0].status, 401);
    assert.equal(created.length, 0);
    assert.equal(headers["Set-Cookie"], undefined);
  });
});

test("a failed session commit rolls the session back instead of signing the user in", async () => {
  await withOwnerToken(async () => {
    const revoked = [];
    const { res, responses, headers } = recorder();
    await loginHandler({ body: { password: "test-owner-password" }, headers: {} }, res, {
      sessions: { create: () => ({ id: "ses_test" }), revoke: (userId, id) => revoked.push(id) },
      commitAuthGroups: async () => { throw Object.assign(new Error("postgres down"), { status: 503, code: "postgres_commit_failed" }); },
    });

    assert.equal(responses[0].status, 503);
    assert.equal(responses[0].body.code, "postgres_commit_failed");
    assert.deepEqual(revoked, ["ses_test"], "the half-created session must not survive");
    assert.equal(headers["Set-Cookie"], undefined, "no cookie may be issued when the commit failed");
  });
});

test("mobile login mints a bearer token for the same identity", async () => {
  await withOwnerToken(async () => {
    const created = [];
    const { res, responses } = recorder();
    await mobileLoginHandler({ body: { password: "test-owner-password" }, headers: {} }, res, throwawayDeps(created));

    assert.equal(responses[0].status, 200);
    assert.equal(responses[0].body.user.id, "creator");
    assert.ok(responses[0].body.accessToken.length > 20);
    assert.equal(responses[0].body.expiresInSeconds, 30 * 86400);
    assert.equal(created[0].kind, "mobile");
  });
});

test("mobile login refuses to answer when authentication is not configured", async () => {
  const previous = config.authToken;
  config.authToken = "";
  try {
    const { res, responses } = recorder();
    await mobileLoginHandler({ body: { password: "anything" }, headers: {} }, res, throwawayDeps());
    assert.equal(responses[0].status, 503);
  } finally {
    config.authToken = previous;
  }
});

test("logout clears the cookie and answers even without a session", async () => {
  const { res, responses, headers } = recorder();
  await logoutHandler({ headers: {} }, res, throwawayDeps());

  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].body.ok, true);
  assert.match(headers["Set-Cookie"], /Max-Age=0/);
});

test("logout revokes the session carried by the request", async () => {
  await withOwnerToken(async () => {
    const created = [];
    const login = recorder();
    await loginHandler({ body: { password: "test-owner-password" }, headers: {} }, login.res, throwawayDeps(created));
    const cookie = String(login.headers["Set-Cookie"]).split(";")[0];

    const revoked = [];
    const { res, responses } = recorder();
    await logoutHandler({ headers: { cookie } }, res, {
      sessions: { create: () => ({ id: "ses_test" }), revoke: (userId, id) => revoked.push({ userId, id }) },
      commitAuthGroups: async () => {},
    });

    assert.equal(responses[0].status, 200);
    assert.deepEqual(revoked, [{ userId: "creator", id: "ses_test" }]);
  });
});

test("the creator identity stays consistent between the two login surfaces", async () => {
  await withOwnerToken(async () => {
    const web = recorder();
    const mobile = recorder();
    await loginHandler({ body: { password: "test-owner-password" }, headers: {} }, web.res, throwawayDeps());
    await mobileLoginHandler({ body: { password: "test-owner-password" }, headers: {} }, mobile.res, throwawayDeps());

    assert.deepEqual(web.responses[0].body.user, mobile.responses[0].body.user);
    assert.deepEqual(web.responses[0].body.user, creatorUser());
  });
});
