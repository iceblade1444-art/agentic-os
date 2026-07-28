import { accountTokens } from "./account-tokens.js";
import { deleteUserAccount } from "./account-lifecycle.js";
import { authenticatedUser } from "./auth.js";
import { governance } from "./governance.js";
import { memberWorkspaces } from "./member-workspace.js";
import { mfa } from "./mfa.js";
import { onboarding, userSoulDocument } from "./onboarding.js";
import { sessions } from "./sessions.js";
import { users } from "./users.js";
import { commitAuthGroups } from "./auth-persistence.js";

function accountError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

export function changeOwnPassword(user, input = {}, dependencies = {}) {
  if (!user || user.id === "creator") throw accountError("The Creator password is managed through server configuration", "creator_managed");
  const userStore = dependencies.users || users;
  const sessionStore = dependencies.sessions || sessions;
  const tokenStore = dependencies.accountTokens || accountTokens;
  const authenticated = userStore.authenticate(user.email, input.currentPassword);
  if (!authenticated || authenticated.id !== user.id) throw accountError("Current password is incorrect", "invalid_password", 401);
  const updated = userStore.setPassword(user.id, input.newPassword);
  sessionStore.removeUser(user.id);
  tokenStore.removeUser(user.id);
  return updated;
}

export async function exportOwnData(user, dependencies = {}) {
  const workspaceStore = dependencies.memberWorkspaces || memberWorkspaces;
  const onboardingStore = dependencies.onboarding || onboarding;
  const sessionStore = dependencies.sessions || sessions;
  const mfaStore = dependencies.mfa || mfa;
  const state = onboardingStore.get(user);
  const soul = userSoulDocument(user, state);
  return {
    format: "agentic-os-personal-export",
    version: 1,
    generatedAt: new Date().toISOString(),
    account: user,
    profile: state.profile || {},
    workspace: workspaceStore.read(user.id),
    soul,
    sessions: sessionStore.list(user.id),
    security: { mfa: mfaStore.status(user) },
  };
}

export async function deleteOwnAccount(user, input = {}, dependencies = {}) {
  if (!user || user.id === "creator") throw accountError("The Creator account is managed through server configuration", "creator_managed");
  const userStore = dependencies.users || users;
  if (String(input.confirmEmail || "").trim().toLowerCase() !== String(user.email).toLowerCase()) {
    throw accountError("Enter the account email exactly to confirm deletion", "confirmation_mismatch");
  }
  const authenticated = userStore.authenticate(user.email, input.password);
  if (!authenticated || authenticated.id !== user.id) throw accountError("Current password is incorrect", "invalid_password", 401);
  return deleteUserAccount(user.id, { ...dependencies, users: userStore });
}

const clearCookie = "aos_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";

export async function changeOwnPasswordHandler(req, res) {
  try {
    const user = authenticatedUser(req);
    changeOwnPassword(user, req.body);
    await commitAuthGroups("users", "sessions", "accountTokens");
    governance.recordAudit("account.password.change", user.name, user.id, "all sessions revoked");
    res.setHeader("Set-Cookie", clearCookie);
    res.json({ ok: true, reauthenticationRequired: true });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code });
  }
}

export async function exportOwnDataHandler(req, res) {
  try {
    const user = authenticatedUser(req);
    const data = await exportOwnData(user);
    governance.recordAudit("account.export", user.name, user.id, "personal data export");
    const filename = `agentic-os-personal-data-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (error) {
    res.status(500).json({ error: `Could not export account data: ${error.message}` });
  }
}

export async function deleteOwnAccountHandler(req, res) {
  try {
    const user = authenticatedUser(req);
    const removed = await deleteOwnAccount(user, req.body);
    await commitAuthGroups("users", "sessions", "mfaRecords", "accountTokens");
    governance.recordAudit("account.delete.self", user.name, removed.id, `role ${removed.role}`);
    res.setHeader("Set-Cookie", clearCookie);
    res.json({ ok: true, deletedUserId: removed.id });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code });
  }
}
