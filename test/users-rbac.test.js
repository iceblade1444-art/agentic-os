import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { capabilities } from "../server/lib/auth.js";
import { UserStore } from "../server/lib/users.js";

function temporaryStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-users-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { store: new UserStore(path.join(dir, "users.json")), file: path.join(dir, "users.json") };
}

test("registered passwords are hashed and duplicate emails are rejected", (t) => {
  const { store, file } = temporaryStore(t);
  const user = store.register({ name: "Team Member", email: "MEMBER@example.com", password: "correct horse battery" });
  assert.equal(user.role, "Member");
  assert.equal(user.email, "member@example.com");
  const persisted = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(persisted, /correct horse battery/);
  assert.match(persisted, /passwordHash/);
  assert.throws(
    () => store.register({ name: "Duplicate", email: "member@example.com", password: "another password" }),
    (error) => error.code === "email_exists",
  );
});

test("authentication, role changes and account disabling revoke sessions", (t) => {
  const { store } = temporaryStore(t);
  const created = store.register({ name: "Operator", email: "operator@example.com", password: "long-safe-password" });
  assert.equal(store.authenticate("operator@example.com", "wrong-password"), null);
  assert.equal(store.authenticate("OPERATOR@example.com", "long-safe-password").id, created.id);

  const before = store.sessionUser(created.id).sessionVersion;
  store.update(created.id, { role: "Viewer" });
  assert.equal(store.sessionUser(created.id).role, "Viewer");
  assert.ok(store.sessionUser(created.id).sessionVersion > before);

  store.update(created.id, { disabled: true });
  assert.equal(store.sessionUser(created.id), null);
  assert.equal(store.authenticate("operator@example.com", "long-safe-password"), null);
});

test("role capabilities enforce the documented access levels", () => {
  assert.deepEqual(capabilities({ role: "Creator" }), { canWrite: true, canAdmin: true, canManageUsers: true });
  assert.deepEqual(capabilities({ role: "Admin" }), { canWrite: true, canAdmin: true, canManageUsers: true });
  assert.deepEqual(capabilities({ role: "Member" }), { canWrite: true, canAdmin: false, canManageUsers: false });
  assert.deepEqual(capabilities({ role: "Viewer" }), { canWrite: false, canAdmin: false, canManageUsers: false });
});

test("frontend scopes personal browser state by authenticated user", () => {
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const store = fs.readFileSync(new URL("../assets/js/store.js", import.meta.url), "utf8");
  assert.match(app, /store\.setScope\(api\.auth\.user\?\.id/);
  assert.match(store, /`\$\{BASE_KEY\}:\$\{scope\}`/);
  assert.match(store, /scope === "creator"/);
});
