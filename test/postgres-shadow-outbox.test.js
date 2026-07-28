import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PostgresShadowOutbox } from "../server/lib/postgres-shadow-outbox.js";
import { hardenRuntimeFile, onRuntimeFileMutation } from "../server/lib/runtime-files.js";

test("PostgreSQL outbox records only bounded migration sources without their contents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-outbox-"));
  const outbox = new PostgresShadowOutbox({ dataDir: root });
  const workspace = path.join(root, "member-workspaces", `${"a".repeat(64)}.json`);
  const secretContent = "private note and password hash";

  fs.mkdirSync(path.dirname(workspace), { recursive: true });
  fs.writeFileSync(path.join(root, "users.json"), secretContent);
  fs.writeFileSync(workspace, secretContent);

  assert.equal(outbox.record(path.join(root, "users.json")), true);
  assert.equal(outbox.record(workspace), true);
  assert.equal(outbox.record(path.join(root, "governance.json")), false);
  assert.equal(outbox.record(path.join(root, "..", "outside.json")), false);

  const events = outbox.snapshot();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.file), [
    "users.json",
    `member-workspaces/${"a".repeat(64)}.json`,
  ]);
  assert.equal(fs.readFileSync(outbox.filePath, "utf8").includes(secretContent), false);
  assert.equal(outbox.status().pending, 2);
});

test("PostgreSQL outbox acknowledges only a successfully copied batch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-outbox-ack-"));
  const outbox = new PostgresShadowOutbox({ dataDir: root });
  outbox.record(path.join(root, "users.json"));
  outbox.record(path.join(root, "sessions.json"));
  const [first] = outbox.snapshot();

  assert.equal(outbox.acknowledge([first.id]), 1);
  assert.equal(outbox.status().pending, 1);
  assert.equal(outbox.snapshot()[0].file, "sessions.json");
});

test("runtime file notifications can durably enqueue an atomic JSON commit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-outbox-hook-"));
  const file = path.join(root, "users.json");
  const outbox = new PostgresShadowOutbox({ dataDir: root });
  const stop = onRuntimeFileMutation((changed) => outbox.record(changed));
  try {
    fs.writeFileSync(file, JSON.stringify({ users: [] }));
    hardenRuntimeFile(file);
    assert.equal(outbox.status().pending, 1);
  } finally {
    stop();
  }
});

test("workspace deletion paths have the same safe relative form as writes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-outbox-delete-"));
  const outbox = new PostgresShadowOutbox({ dataDir: root });
  const userId = "usr_test";
  const key = crypto.createHash("sha256").update(userId).digest("hex");
  assert.equal(outbox.record(path.join(root, "member-workspaces", `${key}.json`)), true);
});

