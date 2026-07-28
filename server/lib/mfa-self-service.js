import crypto from "node:crypto";

import { config } from "../config.js";
import { authenticatedUser } from "./auth.js";
import { governance } from "./governance.js";
import { mfa } from "./mfa.js";
import { sessions } from "./sessions.js";
import { users } from "./users.js";
import { commitAuthGroups } from "./auth-persistence.js";

function constEq(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function passwordMatches(user, password) {
  if (user.id === "creator") return constEq(String(password || ""), config.authToken);
  return users.authenticate(user.email, password)?.id === user.id;
}

function sendError(res, error) {
  res.status(error.status || 400).json({ error: error.message, code: error.code || "mfa_error" });
}

export function mfaStatusHandler(req, res) {
  res.json(mfa.status(authenticatedUser(req)));
}

export async function mfaSetupHandler(req, res) {
  try {
    const user = authenticatedUser(req);
    if (!passwordMatches(user, req.body?.password)) {
      return res.status(401).json({ error: "Current password is incorrect", code: "invalid_password" });
    }
    const setup = await mfa.begin(user);
    await commitAuthGroups("mfaRecords");
    governance.recordAudit("account.mfa.setup", user.name, user.id, "pending authenticator confirmation");
    res.json(setup);
  } catch (error) {
    sendError(res, error);
  }
}

export async function mfaEnableHandler(req, res) {
  try {
    const user = authenticatedUser(req);
    const result = mfa.confirm(user, req.body?.code);
    await commitAuthGroups("mfaRecords");
    governance.recordAudit("account.mfa.enable", user.name, user.id, "TOTP enabled");
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
}

export async function mfaRecoveryHandler(req, res) {
  try {
    const user = authenticatedUser(req);
    const result = mfa.regenerateRecoveryCodes(user, req.body?.code);
    await commitAuthGroups("mfaRecords");
    governance.recordAudit("account.mfa.recovery.regenerate", user.name, user.id, "recovery codes replaced");
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
}

export async function mfaDisableHandler(req, res) {
  try {
    const user = authenticatedUser(req);
    const result = mfa.disable(user, req.body?.code);
    sessions.removeUser(user.id);
    await commitAuthGroups("mfaRecords", "sessions");
    governance.recordAudit("account.mfa.disable", user.name, user.id, "all sessions revoked");
    res.setHeader("Set-Cookie", "aos_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    res.json({ ...result, reauthenticationRequired: true });
  } catch (error) {
    sendError(res, error);
  }
}
