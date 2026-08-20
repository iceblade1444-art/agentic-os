// Integration credentials — OpenAI, Anthropic, GitHub, Notion, Slack, Postgres,
// Telegram, the MILA admin token — sat in data/db.json as plain text, protected
// by file permissions alone, while the governance store next door had used
// AES-256-GCM from the start. These tests pin the sealing and the two ways it
// must not make things worse: an unreadable blob must not crash the server, and
// an install with no stable secret must not encrypt under a key it will lose.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isSealed, open, openValue, seal, sealValue, sealingAvailable } from "../server/lib/secret-box.js";

const NS = "test:integration-config";
const SECRET = "a-stable-secret";
const stable = { secret: SECRET, ephemeral: false };

test("a credential blob does not survive as readable text", () => {
  const sealed = seal({ apiKey: "sk-live-should-not-be-readable" }, NS, stable);

  assert.equal(isSealed(sealed), true);
  assert.doesNotMatch(JSON.stringify(sealed), /sk-live-should-not-be-readable/);
  assert.deepEqual(open(sealed, NS, { secret: SECRET }), { apiKey: "sk-live-should-not-be-readable" });
});

test("sealing is namespaced and authenticated", () => {
  const sealed = sealValue({ token: "t" }, NS, SECRET);

  assert.throws(() => openValue(sealed, "another:namespace", SECRET), "a different namespace must not open it");
  assert.throws(() => openValue(sealed, NS, "another-secret"), "a different secret must not open it");

  const [iv, tag, body] = sealed.split(".");
  const tampered = [iv, tag, Buffer.from("tampered").toString("base64url")].join(".");
  assert.throws(() => openValue(tampered, NS, SECRET), "GCM must reject a modified body");
});

test("each sealing is unique, so equal credentials are not equal on disk", () => {
  const first = seal({ apiKey: "same" }, NS, stable);
  const second = seal({ apiKey: "same" }, NS, stable);
  assert.notEqual(first.__enc, second.__enc);
});

test("stores written before sealing are read unchanged", () => {
  const plain = { apiKey: "written-before-this-change" };
  assert.equal(isSealed(plain), false);
  assert.deepEqual(open(plain, NS, { secret: SECRET }), plain);
});

test("nothing is sealed when there is no stable secret to seal it under", () => {
  // The key would be a fresh random value on the next boot, so encrypting here
  // destroys the credentials instead of protecting them.
  assert.equal(sealingAvailable(true), false);
  const value = { apiKey: "dev" };
  assert.deepEqual(seal(value, NS, { secret: SECRET, ephemeral: true }), value);
});

test("empty configuration stays empty rather than becoming ciphertext", () => {
  assert.deepEqual(seal({}, NS, stable), {});
  assert.deepEqual(seal(undefined, NS, stable), undefined);
});

test("an unreadable blob reports itself instead of throwing", () => {
  const sealed = seal({ apiKey: "k" }, NS, stable);
  const errors = [];

  const opened = open(sealed, NS, { secret: "the-secret-was-rotated", onError: (error) => errors.push(error) });

  assert.deepEqual(opened, {}, "the store must stay usable");
  assert.equal(errors.length, 1, "and the operator must be told why the integration went quiet");
});
