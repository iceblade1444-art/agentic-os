import assert from "node:assert/strict";
import test from "node:test";

import { deleteUserAccount } from "../server/lib/account-lifecycle.js";

test("account deletion removes private workspace, onboarding and knowledge", async () => {
  const calls = [];
  const account = {
    id: "usr_test",
    name: "Test Member",
    email: "test@example.com",
    role: "Member",
  };
  const removed = await deleteUserAccount(account.id, {
    users: {
      get: (id) => id === account.id ? account : null,
      remove: (id) => id === account.id ? account : null,
    },
    memberWorkspaces: { remove: (id) => calls.push(["workspace", id]) },
    onboarding: { remove: (id) => calls.push(["onboarding", id]) },
    sessions: { removeUser: (id) => calls.push(["sessions", id]) },
    accountTokens: { removeUser: (id) => calls.push(["tokens", id]) },
    mfa: { removeUser: (id) => calls.push(["mfa", id]) },
    knowledge: {
      remove: async (note, options) => calls.push(["knowledge", note, options.source]),
    },
  });

  assert.equal(removed.id, account.id);
  assert.deepEqual(calls.slice(0, 4), [
    ["workspace", account.id],
    ["onboarding", account.id],
    ["sessions", account.id],
    ["tokens", account.id],
  ]);
  assert.deepEqual(calls.slice(4, 7).map((call) => call[1]), [
    "Agentic OS/People/usr_test.md",
    "Agentic OS/People/usr_test/SOUL.md",
    "Agentic OS/People/usr_test/MILA Mobile Memory.md",
  ]);
  assert.deepEqual(calls[7], ["mfa", account.id]);
});
