import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { base32Decode, base32Encode, MfaStore, totpCode } from "../server/lib/mfa.js";

const admin = {
  id: "usr_admin",
  name: "Admin Test",
  email: "admin@example.com",
  role: "Admin",
};

test("TOTP implementation follows the RFC 6238 SHA-1 vector", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totpCode(secret, 59_000).code, "287082");
  assert.equal(base32Decode(base32Encode(Buffer.from("12345678901234567890"))).toString(), "12345678901234567890");
});

test("MFA setup encrypts the secret, rejects replay and consumes recovery codes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-mfa-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "mfa.json");
  const store = new MfaStore(file);

  assert.deepEqual(store.status(admin), {
    eligible: true,
    enabled: false,
    enabledAt: "",
    recoveryCodesRemaining: 0,
  });
  const setup = await store.begin(admin);
  assert.match(setup.otpauthUri, /^otpauth:\/\/totp\//);
  assert.match(setup.qrDataUrl, /^data:image\/png;base64,/);
  const persistedSetup = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(persistedSetup, new RegExp(setup.secret));
  assert.match(persistedSetup, /aes-256-gcm/);

  const now = Date.now();
  const enabled = store.confirm(admin, totpCode(setup.secret, now).code, now);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.recoveryCodes.length, 8);
  assert.equal(store.verify(admin, totpCode(setup.secret, now).code, now), false, "the setup TOTP cannot be replayed");

  const next = now + 30_000;
  const nextCode = totpCode(setup.secret, next).code;
  assert.equal(store.verify(admin, nextCode, next), true);
  assert.equal(store.verify(admin, nextCode, next), false, "a login TOTP is single-use");

  const recovery = enabled.recoveryCodes[0];
  assert.equal(store.verify(admin, recovery, next), true);
  assert.equal(store.verify(admin, recovery, next), false, "a recovery code is single-use");
  assert.equal(store.status(admin).recoveryCodesRemaining, 7);

  const persisted = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(persisted, new RegExp(setup.secret));
  for (const code of enabled.recoveryCodes) assert.doesNotMatch(persisted, new RegExp(code));
});

test("MFA is limited to privileged accounts and can be removed with proof", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-mfa-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new MfaStore(path.join(directory, "mfa.json"));
  const member = { ...admin, id: "usr_member", role: "Member" };

  await assert.rejects(store.begin(member), (error) => error.code === "mfa_not_eligible");
  const setup = await store.begin(admin);
  const now = Date.now();
  store.confirm(admin, totpCode(setup.secret, now).code, now);
  const disableAt = now + 30_000;
  assert.equal(store.disable(admin, totpCode(setup.secret, disableAt).code, disableAt).enabled, false);
  assert.equal(store.enabled(admin), false);
});

test("a corrupted MFA store fails closed for privileged accounts", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-mfa-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "mfa.json");
  fs.writeFileSync(file, "{not-json");
  const store = new MfaStore(file);
  assert.throws(
    () => store.enabled(admin),
    (error) => error.code === "mfa_store_unavailable" && error.status === 503,
  );
});

test("MFA challenge routes and both web/mobile login paths are wired", () => {
  const auth = fs.readFileSync(new URL("../server/lib/auth.js", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const settings = fs.readFileSync(new URL("../assets/js/pages/settings.js", import.meta.url), "utf8");

  assert.equal((auth.match(/requireMfa\(user, "(?:web|mobile)", res\)/g) || []).length, 2);
  assert.match(server, /app\.post\("\/api\/auth\/mfa\/verify"/);
  assert.ok(
    server.indexOf('app.post("/api/auth/mfa/verify"') < server.indexOf('app.use("/api", requireAuth)'),
    "MFA verification must complete before authenticated middleware",
  );
  assert.match(api, /verifyMfa/);
  assert.match(app, /result\.mfaRequired/);
  assert.match(settings, /id="mfaSetup"/);
  assert.match(settings, /id="mfaDisable"/);
});
