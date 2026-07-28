import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../server/lib/sessions.js";

test("session registry isolates users and revokes individual devices", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-sessions-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "sessions.json");
  const store = new SessionStore(file);

  const web = store.create("usr_one", { kind: "web", label: "Chrome on Windows" });
  const mobile = store.create("usr_one", { kind: "mobile", label: "MILA Android" });
  store.create("usr_two", { kind: "web", label: "Other user" });

  const own = store.list("usr_one", web.id);
  assert.equal(own.length, 2);
  assert.equal(own.find((session) => session.id === web.id).current, true);
  assert.equal(own.find((session) => session.id === mobile.id).kind, "mobile");
  assert.equal(store.list("usr_two").length, 1);

  assert.equal(store.revoke("usr_one", mobile.id).id, mobile.id);
  assert.equal(store.active(mobile.id, "usr_one"), null);
  assert.equal(store.active(web.id, "usr_two"), null);
  assert.equal(store.list("usr_one").length, 1);

  const persisted = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(persisted, /password|bearer|accessToken/i);
});

test("session registry can revoke all other devices and remove an account", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-sessions-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new SessionStore(path.join(directory, "sessions.json"));
  const current = store.create("usr_one", { kind: "web" });
  store.create("usr_one", { kind: "mobile" });
  store.create("usr_one", { kind: "web" });

  assert.equal(store.revokeOthers("usr_one", current.id), 2);
  assert.deepEqual(store.list("usr_one", current.id).map((session) => session.id), [current.id]);
  assert.equal(store.removeUser("usr_one"), 1);
  assert.deepEqual(store.list("usr_one"), []);
});

test("session routes and security UI are wired for web and mobile accounts", () => {
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const settings = fs.readFileSync(new URL("../assets/js/pages/settings.js", import.meta.url), "utf8");

  assert.match(server, /app\.get\("\/api\/auth\/sessions"/);
  assert.match(server, /app\.delete\("\/api\/auth\/sessions\/:id"/);
  assert.match(server, /app\.post\("\/api\/auth\/sessions\/revoke-others"/);
  assert.ok(
    server.indexOf('app.get("/api/auth/sessions"') < server.indexOf('app.use("/api", requireWriteAccess)'),
    "session self-service must be available before role-based write restrictions",
  );
  assert.match(api, /revokeOtherSessions/);
  assert.match(settings, /settings\.currentSession/);
  assert.match(settings, /revoke-session/);
});
