import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  changeOwnPassword,
  deleteOwnAccount,
  exportOwnData,
} from "../server/lib/account-self-service.js";
import { UserStore } from "../server/lib/users.js";

test("a member can change the password and revoke every session and account token", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-account-self-service-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const users = new UserStore(path.join(directory, "users.json"));
  const user = users.register({
    name: "Member Test",
    email: "member@example.com",
    password: "original-password",
  });
  const calls = [];

  assert.throws(
    () => changeOwnPassword(user, {
      currentPassword: "wrong-password",
      newPassword: "replacement-password",
    }, {
      users,
      sessions: { removeUser: () => calls.push("sessions") },
      accountTokens: { removeUser: () => calls.push("tokens") },
    }),
    (error) => error.code === "invalid_password" && error.status === 401,
  );
  assert.deepEqual(calls, []);

  changeOwnPassword(user, {
    currentPassword: "original-password",
    newPassword: "replacement-password",
  }, {
    users,
    sessions: { removeUser: () => calls.push("sessions") },
    accountTokens: { removeUser: () => calls.push("tokens") },
  });

  assert.equal(users.authenticate(user.email, "original-password"), null);
  assert.equal(users.authenticate(user.email, "replacement-password").id, user.id);
  assert.deepEqual(calls, ["sessions", "tokens"]);
});

test("personal export contains useful account data without credentials or tokens", async () => {
  const user = {
    id: "usr_export",
    name: "Export Member",
    email: "export@example.com",
    role: "Member",
    emailVerified: true,
  };
  const data = await exportOwnData(user, {
    memberWorkspaces: {
      read: () => ({
        version: 1,
        tasks: [{ id: "tsk_one", title: "Ship product", status: "doing" }],
        notes: [{ id: "note_one", title: "Product notes", content: "Useful context" }],
      }),
    },
    onboarding: {
      get: () => ({
        profile: { locale: "uz-UZ", assistantStyle: "mentor" },
        workspace: { name: "Personal workspace" },
      }),
    },
    sessions: {
      list: () => [{
        id: "ses_public",
        kind: "mobile",
        label: "MILA Android",
        createdAt: "2026-07-28T00:00:00.000Z",
        lastSeenAt: "2026-07-28T00:00:00.000Z",
        expiresAt: "2026-08-28T00:00:00.000Z",
        current: true,
      }],
    },
  });

  assert.equal(data.format, "agentic-os-personal-export");
  assert.equal(data.account.id, user.id);
  assert.equal(data.workspace.tasks[0].title, "Ship product");
  assert.equal(data.profile.locale, "uz-UZ");
  assert.match(data.soul.content, /Personal workspace/);
  assert.equal(data.sessions[0].label, "MILA Android");
  assert.doesNotMatch(JSON.stringify(data), /passwordHash|password|salt|digest|bearer|accessToken/i);
});

test("self deletion requires exact ownership proof and removes private data", async () => {
  const user = {
    id: "usr_delete",
    name: "Delete Member",
    email: "delete@example.com",
    role: "Member",
  };
  const calls = [];
  const users = {
    get: (id) => id === user.id ? user : null,
    authenticate: (email, password) =>
      email === user.email && password === "current-password" ? user : null,
    remove: (id) => {
      calls.push(["user", id]);
      return id === user.id ? user : null;
    },
  };
  const dependencies = {
    users,
    memberWorkspaces: { remove: (id) => calls.push(["workspace", id]) },
    onboarding: { remove: (id) => calls.push(["onboarding", id]) },
    sessions: { removeUser: (id) => calls.push(["sessions", id]) },
    accountTokens: { removeUser: (id) => calls.push(["tokens", id]) },
    knowledge: {
      remove: async (note) => calls.push(["knowledge", note]),
    },
  };

  await assert.rejects(
    deleteOwnAccount(user, {
      confirmEmail: "other@example.com",
      password: "current-password",
    }, dependencies),
    (error) => error.code === "confirmation_mismatch",
  );
  await assert.rejects(
    deleteOwnAccount(user, {
      confirmEmail: user.email,
      password: "wrong-password",
    }, dependencies),
    (error) => error.code === "invalid_password" && error.status === 401,
  );
  assert.deepEqual(calls, []);

  const removed = await deleteOwnAccount(user, {
    confirmEmail: "DELETE@EXAMPLE.COM",
    password: "current-password",
  }, dependencies);

  assert.equal(removed.id, user.id);
  assert.deepEqual(calls.slice(0, 4), [
    ["workspace", user.id],
    ["onboarding", user.id],
    ["sessions", user.id],
    ["tokens", user.id],
  ]);
  assert.equal(calls.filter(([kind]) => kind === "knowledge").length, 3);
  assert.deepEqual(calls.at(-1), ["user", user.id]);
});

test("Creator self-managed credentials and deletion stay server-controlled", async () => {
  const creator = { id: "creator", name: "Creator", role: "Creator" };
  assert.throws(
    () => changeOwnPassword(creator, {}),
    (error) => error.code === "creator_managed",
  );
  await assert.rejects(
    deleteOwnAccount(creator, {}),
    (error) => error.code === "creator_managed",
  );
});

test("account self-service routes and Settings UI are connected", () => {
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const settings = fs.readFileSync(new URL("../assets/js/pages/settings.js", import.meta.url), "utf8");

  assert.match(server, /app\.post\("\/api\/auth\/account\/password", rateLimit/);
  assert.match(server, /app\.get\("\/api\/auth\/account\/export"/);
  assert.match(server, /app\.delete\("\/api\/auth\/account", rateLimit/);
  assert.ok(
    server.indexOf('app.post("/api/auth/account/password"') < server.indexOf('app.use("/api", requireWriteAccess)'),
    "account self-service must be available before role-based write restrictions",
  );
  assert.match(api, /changePassword/);
  assert.match(api, /exportPersonalData/);
  assert.match(api, /deleteAccount/);
  assert.match(settings, /id="changePassword"/);
  assert.match(settings, /id="exportPersonalData"/);
  assert.match(settings, /id="deleteAccount"/);
});
