import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { config } from "../server/config.js";
import { authenticatedUser, creatorUser, mobilePairExchangeHandler, mobilePairingGrant, mobileSessionToken, userFromSession } from "../server/lib/auth.js";

test("owner authentication exposes the Creator identity", () => {
  assert.deepEqual(creatorUser(), config.creator);
  assert.equal(creatorUser().role, "Creator");
});

test("mobile bearer sessions authenticate through the same account identity", () => {
  const previous = config.authToken;
  config.authToken = "test-owner-password";
  try {
    const token = mobileSessionToken(creatorUser());
    const user = authenticatedUser({ headers: { authorization: `Bearer ${token}` } });
    assert.equal(user.id, "creator");
    assert.equal(user.role, "Creator");
    assert.equal(authenticatedUser({ headers: { authorization: "Bearer invalid" } }), null);
  } finally {
    config.authToken = previous;
  }
});

test("signed user sessions preserve registered user display names", () => {
  assert.deepEqual(userFromSession({ user: {
    id: "user-42", name: "  Milana  ", email: "milana@example.com", role: "Member",
  } }), {
    id: "user-42", name: "Milana", email: "milana@example.com", role: "Member", avatar: "",
  });
  assert.equal(userFromSession({}).name, config.creator.name);
});

test("a mobile pairing grant exchanges once for the same account identity", async () => {
  const grant = mobilePairingGrant(creatorUser());
  const responses = [];
  const response = {
    status(code) { this.statusCode = code; return this; },
    json(body) { responses.push({ status: this.statusCode || 200, body }); return this; },
  };
  await mobilePairExchangeHandler({ body: { grant } }, response);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].body.user.id, "creator");
  assert.equal(authenticatedUser({
    headers: { authorization: `Bearer ${responses[0].body.accessToken}` },
  }).role, "Creator");

  await mobilePairExchangeHandler({ body: { grant } }, response);
  assert.equal(responses[1].status, 401);
});

test("frontend replaces demo profile with the authenticated session user", () => {
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const store = fs.readFileSync(new URL("../assets/js/store.js", import.meta.url), "utf8");
  assert.match(app, /syncAuthenticatedProfile/);
  assert.match(app, /api\.auth\.user/);
  assert.match(api, /state\.user = me\.user/);
  assert.doesNotMatch(store, /Sofia Carter|sofia@acme\.com/);
});
