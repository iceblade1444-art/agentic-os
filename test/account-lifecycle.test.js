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
    // Every store the deletion reaches must be stubbed, or the fallback is the
    // REAL one: this test used to run messenger.removeUser against the
    // production messenger index on every deploy-gate run.
    googleWorkspace: { disconnect: (id) => calls.push(["google", id]) },
    personalFiles: { removeUser: (id) => calls.push(["files", id]) },
    personalProfiles: { clear: (id) => calls.push(["profile", id]) },
    pushDevices: { removeUser: (id) => calls.push(["push", id]) },
    reminders: { removeUser: (id) => calls.push(["reminders", id]) },
    messenger: { removeUser: (id) => calls.push(["messenger", id]) },
    telegram: { removeUser: (id) => calls.push(["telegram", id]) },
  });

  assert.equal(removed.id, account.id);
  // Deletion must reach every store that holds anything of this person's.
  // Asserted as membership, not position: the order is an implementation
  // detail, the coverage is the contract.
  for (const store of [
    "workspace", "onboarding", "sessions", "tokens", "google", "files",
    "profile", "push", "reminders", "messenger", "telegram", "mfa",
  ]) {
    assert.ok(
      calls.some(([tag, id]) => tag === store && id === account.id),
      `${store} was never asked to remove ${account.id}`,
    );
  }
  assert.deepEqual(calls.filter(([tag]) => tag === "knowledge").map((call) => call[1]), [
    "Agentic OS/People/usr_test.md",
    "Agentic OS/People/usr_test/SOUL.md",
    "Agentic OS/People/usr_test/MILA Mobile Memory.md",
  ]);
});
