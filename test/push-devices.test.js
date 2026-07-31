import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PushDeviceStore } from "../server/lib/push-devices.js";

const token = (suffix) => `firebase-registration-token-${suffix}-${"x".repeat(32)}`;

test("push devices are isolated by user and tokens move between accounts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-push-"));
  const store = new PushDeviceStore(path.join(dir, "devices.json"));
  try {
    store.register("user-a", { deviceId: "phone", token: token("a"), locale: "ru" });
    store.register("user-b", { deviceId: "tablet", token: token("b"), locale: "uz" });
    assert.equal(store.list("user-a").length, 1);
    assert.equal(store.list("user-b").length, 1);

    store.register("user-b", { deviceId: "new-phone", token: token("a"), locale: "en" });
    assert.equal(store.list("user-a").length, 0);
    assert.equal(store.list("user-b").length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("push devices can be removed by device, token, or account", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-push-"));
  const store = new PushDeviceStore(path.join(dir, "devices.json"));
  try {
    store.register("user-a", { deviceId: "one", token: token("one") });
    store.register("user-a", { deviceId: "two", token: token("two") });
    assert.equal(store.remove("user-a", "one"), true);
    assert.equal(store.removeTokens([token("two")]), 1);
    assert.equal(store.list("user-a").length, 0);
    store.register("user-a", { deviceId: "three", token: token("three") });
    assert.equal(store.removeUser("user-a"), true);
    assert.equal(store.list("user-a").length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("push device registration rejects malformed tokens", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-push-"));
  const store = new PushDeviceStore(path.join(dir, "devices.json"));
  try {
    assert.throws(() => store.register("user-a", { token: "short" }), /valid push token/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
