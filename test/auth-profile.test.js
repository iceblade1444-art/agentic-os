import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { config } from "../server/config.js";
import { creatorUser, userFromSession } from "../server/lib/auth.js";

test("owner authentication exposes the Creator identity", () => {
  assert.deepEqual(creatorUser(), config.creator);
  assert.equal(creatorUser().role, "Creator");
});

test("signed user sessions preserve registered user display names", () => {
  assert.deepEqual(userFromSession({ user: {
    id: "user-42", name: "  Milana  ", email: "milana@example.com", role: "Member",
  } }), {
    id: "user-42", name: "Milana", email: "milana@example.com", role: "Member", avatar: "",
  });
  assert.equal(userFromSession({}).name, config.creator.name);
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
