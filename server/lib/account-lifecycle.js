import { knowledge } from "./knowledge.js";
import { governance } from "./governance.js";
import { memberWorkspaces } from "./member-workspace.js";
import { onboarding, safeUserSlug } from "./onboarding.js";
import { sessions } from "./sessions.js";
import { accountTokens } from "./account-tokens.js";
import { mfa } from "./mfa.js";
import { users } from "./users.js";
import { commitAuthGroups } from "./auth-persistence.js";
import { googleWorkspace } from "./google-workspace.js";
import { personalFiles } from "./personal-files.js";
import { personalProfiles } from "./personal-profile.js";
import { pushDevices } from "./push-devices.js";

let configuredWorkspaceStore = memberWorkspaces;

export async function deleteUserAccount(id, dependencies = {}) {
  const userStore = dependencies.users || users;
  const workspaceStore = dependencies.memberWorkspaces || configuredWorkspaceStore;
  const onboardingStore = dependencies.onboarding || onboarding;
  const knowledgeStore = dependencies.knowledge || knowledge;
  const sessionStore = dependencies.sessions || sessions;
  const tokenStore = dependencies.accountTokens || accountTokens;
  const mfaStore = dependencies.mfa || mfa;
  const googleStore = dependencies.googleWorkspace || googleWorkspace;
  const personalFileStore = dependencies.personalFiles || personalFiles;
  const profileStore = dependencies.personalProfiles || personalProfiles;
  const pushDeviceStore = dependencies.pushDevices || pushDevices;
  const user = userStore.get(id);
  if (!user) return null;

  await workspaceStore.remove(id);
  onboardingStore.remove(id);
  sessionStore.removeUser(id);
  tokenStore.removeUser(id);
  googleStore.disconnect(id);
  personalFileStore.removeUser(id);
  // Everything MILA was told about this person goes with the account.
  profileStore.clear(id);
  pushDeviceStore.removeUser(id);

  const slug = safeUserSlug(user);
  for (const note of [
    `Agentic OS/People/${slug}.md`,
    `Agentic OS/People/${slug}/SOUL.md`,
    `Agentic OS/People/${slug}/MILA Mobile Memory.md`,
  ]) {
    await knowledgeStore.remove(note, {
      actor: "Agentic OS account lifecycle",
      source: "account-delete",
    });
  }

  mfaStore.removeUser(id);
  const removed = userStore.remove(id);
  await commitAuthGroups("users", "sessions", "mfaRecords", "accountTokens");
  return removed;
}

export function configureAccountWorkspaceStore(store) {
  configuredWorkspaceStore = store || memberWorkspaces;
}

export async function deleteUserHandler(req, res) {
  if (req.params.id === "creator") {
    return res.status(400).json({
      error: "The Creator account is managed through server configuration",
    });
  }
  try {
    const removed = await deleteUserAccount(req.params.id);
    if (!removed) return res.status(404).json({ error: "User not found" });
    governance.recordAudit("account.delete", req.user?.name, removed.id, `role ${removed.role}`);
    res.json({ ok: true, user: removed });
  } catch (error) {
    res.status(500).json({ error: `Could not delete account: ${error.message}` });
  }
}
