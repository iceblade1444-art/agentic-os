import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AccountTokenStore } from "../server/lib/account-tokens.js";
import { AccountMailer } from "../server/lib/mailer.js";
import { UserStore } from "../server/lib/users.js";

test("verification and password reset tokens are hashed, single-use and purpose-bound", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-account-token-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "tokens.json");
  const store = new AccountTokenStore(file);

  const verification = store.create("usr_one", "verify_email", 60_000);
  const reset = store.create("usr_one", "reset_password", 60_000);
  const persisted = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(persisted, new RegExp(verification));
  assert.doesNotMatch(persisted, new RegExp(reset));
  assert.equal(store.consume(verification, "reset_password"), null);
  assert.equal(store.consume(verification, "verify_email"), "usr_one");
  assert.equal(store.consume(verification, "verify_email"), null);
  assert.equal(store.consume(reset, "reset_password"), "usr_one");
});

test("new unverified users can be confirmed and password changes revoke session versions", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-recovery-user-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new UserStore(path.join(directory, "users.json"));
  const created = store.register({
    name: "Recovery User",
    email: "recovery@example.com",
    password: "initial-safe-password",
    emailVerified: false,
  });
  assert.equal(created.emailVerified, false);
  assert.equal(store.markEmailVerified(created.id).emailVerified, true);
  const version = store.sessionUser(created.id).sessionVersion;
  store.setPassword(created.id, "replacement-password");
  assert.equal(store.authenticate("recovery@example.com", "initial-safe-password"), null);
  assert.equal(store.authenticate("recovery@example.com", "replacement-password").sessionVersion, version + 1);
});

test("email delivery stays disabled without SMTP and public status exposes no credentials", () => {
  const mailer = new AccountMailer({ host: "", port: 587, secure: false, user: "", password: "", from: "" });
  assert.equal(mailer.ready, false);
  const recovery = fs.readFileSync(new URL("../server/lib/account-recovery.js", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  assert.match(recovery, /If the account exists/);
  assert.match(server, /\/api\/auth\/password\/forgot/);
  assert.match(server, /\/api\/auth\/email\/verify/);
  assert.match(app, /api\.auth\.resetPassword/);
  assert.doesNotMatch(recovery, /SMTP_PASSWORD/);
});
