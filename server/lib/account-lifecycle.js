import { knowledge } from "./knowledge.js";
import { governance } from "./governance.js";
import { memberWorkspaces } from "./member-workspace.js";
import { onboarding, safeUserSlug } from "./onboarding.js";
import { sessions } from "./sessions.js";
import { accountTokens } from "./account-tokens.js";
import { users } from "./users.js";

export async function deleteUserAccount(id, dependencies = {}) {
  const userStore = dependencies.users || users;
  const workspaceStore = dependencies.memberWorkspaces || memberWorkspaces;
  const onboardingStore = dependencies.onboarding || onboarding;
  const knowledgeStore = dependencies.knowledge || knowledge;
  const sessionStore = dependencies.sessions || sessions;
  const tokenStore = dependencies.accountTokens || accountTokens;
  const user = userStore.get(id);
  if (!user) return null;

  workspaceStore.remove(id);
  onboardingStore.remove(id);
  sessionStore.removeUser(id);
  tokenStore.removeUser(id);

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

  return userStore.remove(id);
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
