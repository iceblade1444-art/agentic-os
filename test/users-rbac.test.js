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

test("removing an account revokes authentication and deletes the persisted user", (t) => {
  const { store, file } = temporaryStore(t);
  const created = store.register({
    name: "Temporary Member",
    email: "temporary@example.com",
    password: "long-safe-password",
  });
  assert.equal(store.remove(created.id).email, "temporary@example.com");
  assert.equal(store.authenticate("temporary@example.com", "long-safe-password"), null);
  assert.equal(store.get(created.id), null);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /temporary@example\.com/);
  assert.equal(store.remove(created.id), null);
});

test("role capabilities enforce the documented access levels", () => {
  assert.deepEqual(capabilities({ role: "Creator" }), { canWrite: true, canAdmin: true, canManageUsers: true, canStudio: true });
  assert.deepEqual(capabilities({ role: "Admin" }), { canWrite: true, canAdmin: true, canManageUsers: true, canStudio: true });
  assert.deepEqual(capabilities({ role: "Design" }), { canWrite: true, canAdmin: false, canManageUsers: false, canStudio: true });
  assert.deepEqual(capabilities({ role: "Member" }), { canWrite: true, canAdmin: false, canManageUsers: false, canStudio: false });
  assert.deepEqual(capabilities({ role: "Viewer" }), { canWrite: false, canAdmin: false, canManageUsers: false, canStudio: false });
});

test("Design is assignable and unknown roles stay rejected", (t) => {
  const { store } = temporaryStore(t);
  const created = store.register({ name: "Studio Lead", email: "studio@example.com", password: "long-safe-password" });
  assert.equal(store.update(created.id, { role: "Design" }).role, "Design");
  assert.throws(() => store.update(created.id, { role: "Analyst" }), (error) => error.code === "invalid_role");
  assert.equal(store.get(created.id).role, "Design");
});

test("a pending account authenticates but gets no session until it is approved", (t) => {
  const { store } = temporaryStore(t);
  const created = store.register({
    name: "Bahadir Yakubov",
    email: "pending@example.com",
    password: "long-safe-password",
    requiresApproval: true,
  });
  assert.equal(created.approved, false);
  // The password is right, so the login handler can say "waiting for approval"...
  assert.equal(store.authenticate("pending@example.com", "long-safe-password").approved, false);
  // ...but no session may exist for the account.
  assert.equal(store.sessionUser(created.id), null);

  const approved = store.update(created.id, { approved: true });
  assert.equal(approved.approved, true);
  assert.notEqual(approved.approvedAt, "");
  assert.equal(store.sessionUser(created.id).approved, true);

  // Revoking approval invalidates existing sessions the same way a role change does.
  const before = store.sessionUser(created.id).sessionVersion;
  store.update(created.id, { approved: false });
  assert.equal(store.sessionUser(created.id), null);
  assert.ok(store.get(created.id).approved === false);
  assert.ok(before >= 1);
});

test("accounts created without the approval gate stay usable", (t) => {
  const { store, file } = temporaryStore(t);
  const created = store.register({ name: "Legacy", email: "legacy@example.com", password: "long-safe-password" });
  assert.equal(created.approved, true);
  assert.equal(store.sessionUser(created.id).approved, true);

  // Simulate a record written before approvedAt existed at all.
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  delete raw.users[0].approvedAt;
  fs.writeFileSync(file, JSON.stringify(raw));
  const reloaded = new UserStore(file);
  assert.equal(reloaded.sessionUser(created.id).approved, true);
  assert.equal(reloaded.authenticate("legacy@example.com", "long-safe-password").approved, true);
});

test("frontend scopes personal browser state by authenticated user", () => {
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const store = fs.readFileSync(new URL("../assets/js/store.js", import.meta.url), "utf8");
  assert.match(app, /store\.setScope\(api\.auth\.user\?\.id/);
  assert.match(store, /`\$\{BASE_KEY\}:\$\{scope\}`/);
  assert.match(store, /scope === "creator"/);
});
