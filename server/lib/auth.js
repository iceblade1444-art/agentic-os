// Minimal, dependency-free auth: a single admin token (AUTH_TOKEN). Browser logs in
// and gets an HMAC-signed, httpOnly session cookie; API clients (the MCP bridge) may
// send `Authorization: Bearer <AUTH_TOKEN>`. When AUTH_TOKEN is unset, auth is
// disabled (local dev) — the server logs a warning at startup.
import crypto from "node:crypto";
import { config } from "../config.js";
import { governance } from "./governance.js";
import { sessions } from "./sessions.js";
import { users } from "./users.js";
import { accountMailer } from "./mailer.js";
import { accountTokens } from "./account-tokens.js";
import { sendVerification } from "./account-recovery.js";
import { mfa } from "./mfa.js";
import { commitAuthGroups } from "./auth-persistence.js";

const COOKIE = "aos_session";
const b64 = (buf) => Buffer.from(buf).toString("base64url");
const usedPairingGrants = new Map();
const usedMfaChallenges = new Map();
let authReadAdapter = null;

export function configureAuthReadAdapter(adapter) {
  authReadAdapter = adapter;
}

const authenticateAccount = (email, password) =>
  authReadAdapter ? authReadAdapter.authenticate(email, password) : users.authenticate(email, password);
const readSessionUser = (id) =>
  authReadAdapter ? authReadAdapter.sessionUser(id) : users.sessionUser(id);
const touchSession = (id, userId) =>
  authReadAdapter ? authReadAdapter.touchSession(id, userId) : sessions.touch(id, userId);

export function authEnabled() { return !!config.authToken; }

// A pending account authenticates but gets no session until the owner approves it.
function approvalPending(user, res) {
  if (!user || user.id === "creator" || user.approved !== false) return false;
  res.status(403).json({
    error: "Your account is waiting for approval from the workspace owner",
    code: "approval_pending",
  });
  return true;
}

function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac("sha256", config.sessionSecret).update(body).digest("base64url");
  return body + "." + mac;
}
function verify(token) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = crypto.createHmac("sha256", config.sessionSecret).update(body).digest("base64url");
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); if (p.exp && Date.now() > p.exp) return null; return p; }
  catch { return null; }
}
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => {
    const i = c.indexOf("="); if (i < 0) return ["", ""];
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }).filter(([k]) => k));
}
function constEq(a, b) {
  if (typeof a !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function creatorUser() {
  return { ...config.creator };
}

export function userFromSession(payload) {
  const user = payload?.user;
  if (!user || typeof user.name !== "string" || !user.name.trim()) return creatorUser();
  return {
    id: String(user.id || "user").slice(0, 100),
    name: user.name.trim().slice(0, 120),
    email: String(user.email || "").trim().slice(0, 200),
    role: String(user.role || "User").trim().slice(0, 80),
    avatar: String(user.avatar || "").trim().slice(0, 1000),
  };
}

export function authenticatedUser(req) {
  if (!authEnabled()) return creatorUser();
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    if (constEq(token, config.authToken)) return creatorUser();
    const payload = verify(token);
    if (payload?.kind !== "mobile" || !payload.user?.id) return null;
    if (payload.sid && !touchSession(payload.sid, String(payload.user.id))) return null;
    if (payload.user.id === "creator") return creatorUser();
    const user = readSessionUser(String(payload.user.id));
    if (!user || Number(payload.sessionVersion) !== user.sessionVersion) return null;
    return userFromSession({ user });
  }
  const payload = verify(parseCookies(req)[COOKIE]);
  if (!payload?.user) return null;
  if (payload.sid && !touchSession(payload.sid, String(payload.user.id))) return null;
  if (payload.user.id === "creator") return creatorUser();
  const user = readSessionUser(String(payload.user.id || ""));
  if (!user || Number(payload.sessionVersion) !== user.sessionVersion) return null;
  return userFromSession({ user });
}

export function isAuthed(req) {
  return !!authenticatedUser(req);
}

export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "unauthorized" });
}

export function requireRoles(...allowed) {
  const roles = new Set(allowed);
  return (req, res, next) => {
    const user = authenticatedUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    if (!roles.has(user.role)) return res.status(403).json({ error: "forbidden", requiredRoles: [...roles] });
    req.user = user;
    next();
  };
}

export function requireWriteAccess(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  return requireRoles("Creator", "Admin", "CEO", "Design", "Member")(req, res, next);
}

export function capabilities(user) {
  const role = user?.role || "Viewer";
  return {
    canWrite: ["Creator", "Admin", "CEO", "Design", "Member"].includes(role),
    canAdmin: ["Creator", "Admin", "CEO"].includes(role),
    canManageUsers: ["Creator", "Admin", "CEO"].includes(role),
    canStudio: ["Creator", "Admin", "CEO", "Design"].includes(role),
  };
}

export function sessionCookie(req, user = creatorUser(), sid = "") {
  const token = sign({ exp: Date.now() + 7 * 864e5, user: userFromSession({ user }), sessionVersion: Number(user.sessionVersion) || 1, ...(sid ? { sid } : {}) });
  const secure = config.secureCookie || req.secure ? "; Secure" : "";
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}${secure}`;
}

export function mobileSessionToken(user, sid = "") {
  return sign({
    exp: Date.now() + 30 * 864e5,
    kind: "mobile",
    user: userFromSession({ user }),
    sessionVersion: Number(user.sessionVersion) || 1,
    ...(sid ? { sid } : {}),
  });
}

function requestLabel(req, kind) {
  const agent = String(req.headers?.["user-agent"] || "").replace(/\s+/g, " ").trim().slice(0, 140);
  return `${kind === "mobile" ? "MILA mobile" : "Web browser"}${agent ? ` · ${agent}` : ""}`;
}

function createTrackedSession(req, user, kind) {
  const days = kind === "mobile" ? 30 : 7;
  return sessions.create(user.id, {
    kind,
    label: requestLabel(req, kind),
    expiresAt: Date.now() + days * 864e5,
  });
}

function mfaChallenge(user, channel) {
  return sign({
    exp: Date.now() + 5 * 60 * 1000,
    kind: "mfa_challenge",
    channel,
    jti: crypto.randomUUID(),
    user: userFromSession({ user }),
    sessionVersion: Number(user?.sessionVersion) || 1,
  });
}

function challengeUser(payload) {
  if (payload?.kind !== "mfa_challenge" || !payload.jti || !payload.user?.id) return null;
  if (payload.user.id === "creator") return creatorUser();
  const user = readSessionUser(String(payload.user.id));
  if (!user || Number(payload.sessionVersion) !== user.sessionVersion) return null;
  return user;
}

function requireMfa(user, channel, res) {
  try {
    if (!mfa.enabled(user)) return false;
  } catch (error) {
    res.status(error.status || 503).json({ error: "MFA verification is temporarily unavailable", code: error.code || "mfa_unavailable" });
    return true;
  }
  res.status(202).json({
    ok: false,
    mfaRequired: true,
    challenge: mfaChallenge(user, channel),
    expiresInSeconds: 300,
    user: { name: user.name, role: user.role },
  });
  return true;
}

function signedPayload(req) {
  const auth = req.headers?.authorization || "";
  if (auth.startsWith("Bearer ") && !constEq(auth.slice(7), config.authToken)) return verify(auth.slice(7));
  return verify(parseCookies(req)[COOKIE]);
}

export function mobilePairingGrant(user) {
  return sign({
    exp: Date.now() + 10 * 60 * 1000,
    kind: "mobile_pair",
    jti: crypto.randomUUID(),
    user: userFromSession({ user }),
    sessionVersion: Number(user?.sessionVersion) || 1,
  });
}

function pairingUser(payload) {
  if (payload?.kind !== "mobile_pair" || !payload.jti || !payload.user?.id) return null;
  if (payload.user.id === "creator") return creatorUser();
  const user = readSessionUser(String(payload.user.id));
  if (!user || Number(payload.sessionVersion) !== user.sessionVersion) return null;
  return user;
}

// deps exists for tests: the handler creates a real tracked session, and a
// test that runs against the production data directory (the deploy gate does)
// must be able to hand in a throwaway store instead of writing a session the
// owner will find in their device list.
export async function mobilePairExchangeHandler(req, res, deps = {}) {
  const sessionStore = deps.sessions || sessions;
  const commit = deps.commitAuthGroups || commitAuthGroups;
  const now = Date.now();
  for (const [id, expiresAt] of usedPairingGrants) {
    if (expiresAt <= now) usedPairingGrants.delete(id);
  }

  const payload = verify(String(req.body?.grant || ""));
  const user = pairingUser(payload);
  if (!user || usedPairingGrants.has(payload.jti)) {
    return res.status(401).json({ error: "Invalid, expired, or already used connection grant" });
  }
  usedPairingGrants.set(payload.jti, Number(payload.exp) || now + 10 * 60 * 1000);
  const session = sessionStore.create(user.id, { kind: "mobile", label: requestLabel(req, "mobile"), expiresAt: Date.now() + 30 * 864e5 });
  try {
    await commit("sessions");
  } catch (error) {
    sessionStore.revoke(user.id, session.id);
    await commit("sessions").catch(() => {});
    return res.status(error.status || 503).json({ error: error.message, code: error.code });
  }
  res.json({
    ok: true,
    accessToken: mobileSessionToken(user, session.id),
    expiresInSeconds: 30 * 86400,
    user: userFromSession({ user }),
    capabilities: capabilities(user),
  });
}

export async function loginHandler(req, res) {
  if (!authEnabled()) return res.json({ ok: true, required: false, user: creatorUser() });
  const { email = "", password = "" } = req.body || {};
  const user = email ? authenticateAccount(email, password) : (constEq(password, config.authToken) ? creatorUser() : null);
  if (!user) return res.status(401).json({ error: "Invalid email or password" });
  if (config.emailVerificationRequired && user.id !== "creator" && !user.emailVerified) {
    return res.status(403).json({ error: "Confirm your email before signing in", code: "email_unverified" });
  }
  if (approvalPending(user, res)) return;
  if (requireMfa(user, "web", res)) return;
  const session = createTrackedSession(req, user, "web");
  try {
    await commitAuthGroups("sessions");
  } catch (error) {
    sessions.revoke(user.id, session.id);
    await commitAuthGroups("sessions").catch(() => {});
    return res.status(error.status || 503).json({ error: error.message, code: error.code });
  }
  res.setHeader("Set-Cookie", sessionCookie(req, user, session.id));
  res.json({ ok: true, user: userFromSession({ user }), capabilities: capabilities(user) });
}
export async function registerHandler(req, res) {
  if (!config.allowRegistration) return res.status(403).json({ error: "Registration is disabled" });
  if (config.emailVerificationRequired && !accountMailer.ready) return res.status(503).json({ error: "Email delivery is not configured" });
  let createdUser = null;
  try {
    const user = users.register({
      ...(req.body || {}),
      emailVerified: !config.emailVerificationRequired,
      requiresApproval: config.requireAccountApproval,
    });
    createdUser = user;
    if (config.emailVerificationRequired) {
      try {
        await sendVerification(user);
        await commitAuthGroups("users", "accountTokens");
        return res.status(201).json({ ok: true, verificationRequired: true, approvalRequired: config.requireAccountApproval, user: userFromSession({ user }) });
      } catch (error) {
        accountTokens.removeUser(user.id);
        users.remove(user.id);
        await commitAuthGroups("users", "accountTokens").catch(() => {});
        return res.status(503).json({ error: "Could not send verification email. Try again later." });
      }
    }
    if (config.requireAccountApproval) {
      await commitAuthGroups("users");
      governance.recordAudit("account.registered", user.name, user.id, "waiting for owner approval");
      return res.status(201).json({ ok: true, approvalRequired: true, user: userFromSession({ user }) });
    }
    const session = createTrackedSession(req, user, "web");
    await commitAuthGroups("users", "sessions");
    res.setHeader("Set-Cookie", sessionCookie(req, user, session.id));
    res.status(201).json({ ok: true, user: userFromSession({ user }), capabilities: capabilities(user) });
  } catch (error) {
    if (error.code === "postgres_commit_failed" && createdUser) {
      sessions.removeUser(createdUser.id);
      accountTokens.removeUser(createdUser.id);
      users.remove(createdUser.id);
      await commitAuthGroups("users", "sessions", "accountTokens").catch(() => {});
    }
    res.status(error.status || (error.code === "email_exists" ? 409 : 400)).json({ error: error.message, code: error.code });
  }
}

export async function mobileLoginHandler(req, res) {
  if (!authEnabled()) return res.status(503).json({ error: "Authentication is not configured" });
  const { email = "", password = "" } = req.body || {};
  const user = email ? authenticateAccount(email, password) : (constEq(password, config.authToken) ? creatorUser() : null);
  if (!user) return res.status(401).json({ error: "Invalid email or password" });
  if (config.emailVerificationRequired && user.id !== "creator" && !user.emailVerified) {
    return res.status(403).json({ error: "Confirm your email before signing in", code: "email_unverified" });
  }
  if (approvalPending(user, res)) return;
  if (requireMfa(user, "mobile", res)) return;
  const session = sessionStore.create(user.id, { kind: "mobile", label: requestLabel(req, "mobile"), expiresAt: Date.now() + 30 * 864e5 });
  try {
    await commit("sessions");
  } catch (error) {
    sessionStore.revoke(user.id, session.id);
    await commit("sessions").catch(() => {});
    return res.status(error.status || 503).json({ error: error.message, code: error.code });
  }
  res.json({
    ok: true,
    accessToken: mobileSessionToken(user, session.id),
    expiresInSeconds: 30 * 86400,
    user: userFromSession({ user }),
    capabilities: capabilities(user),
  });
}

export async function mobileRegisterHandler(req, res) {
  if (!config.allowRegistration) return res.status(403).json({ error: "Registration is disabled" });
  if (config.emailVerificationRequired && !accountMailer.ready) return res.status(503).json({ error: "Email delivery is not configured" });
  let createdUser = null;
  try {
    const user = users.register({
      ...(req.body || {}),
      emailVerified: !config.emailVerificationRequired,
      requiresApproval: config.requireAccountApproval,
    });
    createdUser = user;
    if (config.emailVerificationRequired) {
      try {
        await sendVerification(user);
        await commitAuthGroups("users", "accountTokens");
        return res.status(201).json({ ok: true, verificationRequired: true, approvalRequired: config.requireAccountApproval, user: userFromSession({ user }) });
      } catch (error) {
        accountTokens.removeUser(user.id);
        users.remove(user.id);
        await commitAuthGroups("users", "accountTokens").catch(() => {});
        return res.status(503).json({ error: "Could not send verification email. Try again later." });
      }
    }
    if (config.requireAccountApproval) {
      await commitAuthGroups("users");
      governance.recordAudit("account.registered", user.name, user.id, "waiting for owner approval");
      return res.status(201).json({ ok: true, approvalRequired: true, user: userFromSession({ user }) });
    }
    const session = sessionStore.create(user.id, { kind: "mobile", label: requestLabel(req, "mobile"), expiresAt: Date.now() + 30 * 864e5 });
    await commitAuthGroups("users", "sessions");
    res.status(201).json({
      ok: true,
      accessToken: mobileSessionToken(user, session.id),
      expiresInSeconds: 30 * 86400,
      user: userFromSession({ user }),
      capabilities: capabilities(user),
    });
  } catch (error) {
    if (error.code === "postgres_commit_failed" && createdUser) {
      sessions.removeUser(createdUser.id);
      accountTokens.removeUser(createdUser.id);
      users.remove(createdUser.id);
      await commitAuthGroups("users", "sessions", "accountTokens").catch(() => {});
    }
    res.status(error.status || (error.code === "email_exists" ? 409 : 400)).json({ error: error.message, code: error.code });
  }
}
export async function logoutHandler(req, res) {
  const payload = signedPayload(req);
  if (payload?.sid && payload.user?.id) sessions.revoke(String(payload.user.id), payload.sid);
  await commit("sessions").catch(() => {});
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
}

export async function mfaVerifyHandler(req, res) {
  try {
    const now = Date.now();
    for (const [id, expiresAt] of usedMfaChallenges) {
      if (expiresAt <= now) usedMfaChallenges.delete(id);
    }
    const payload = verify(String(req.body?.challenge || ""));
    const user = challengeUser(payload);
    if (!user || usedMfaChallenges.has(payload.jti) || !["web", "mobile"].includes(payload.channel) || !mfa.verify(user, req.body?.code)) {
      return res.status(401).json({ error: "Invalid or expired MFA challenge", code: "invalid_mfa_challenge" });
    }
    usedMfaChallenges.set(payload.jti, Number(payload.exp) || now + 5 * 60 * 1000);
    const session = createTrackedSession(req, user, payload.channel);
    await commitAuthGroups("mfaRecords", "sessions");
    governance.recordAudit("account.mfa.login", user.name, user.id, payload.channel);
    if (payload.channel === "mobile") {
      return res.json({
        ok: true,
        accessToken: mobileSessionToken(user, session.id),
        expiresInSeconds: 30 * 86400,
        user: userFromSession({ user }),
        capabilities: capabilities(user),
      });
    }
    res.setHeader("Set-Cookie", sessionCookie(req, user, session.id));
    res.json({ ok: true, user: userFromSession({ user }), capabilities: capabilities(user) });
  } catch (error) {
    res.status(error.status || 401).json({
      error: error.code === "postgres_commit_failed" ? error.message : "Invalid or expired MFA challenge",
      code: error.code || "invalid_mfa_challenge",
    });
  }
}
export function meHandler(req, res) {
  const user = authenticatedUser(req);
  res.json({ required: authEnabled(), registration: config.allowRegistration, authed: !!user, user, capabilities: capabilities(user) });
}

export function listUsersHandler(req, res) {
  res.json([creatorUser(), ...(authReadAdapter ? authReadAdapter.listUsers() : users.list())]);
}

export function listSessionsHandler(req, res) {
  const user = authenticatedUser(req);
  const currentId = signedPayload(req)?.sid || "";
  res.json({
    sessions: authReadAdapter
      ? authReadAdapter.listSessions(user.id, currentId)
      : sessions.list(user.id, currentId),
    legacyCurrent: !currentId,
  });
}

export async function revokeSessionHandler(req, res) {
  const user = authenticatedUser(req);
  const currentId = signedPayload(req)?.sid || "";
  const revoked = sessions.revoke(user.id, String(req.params.id || ""));
  if (!revoked) return res.status(404).json({ error: "Session not found" });
  await commitAuthGroups("sessions");
  if (revoked.id === currentId && revoked.kind === "web") {
    res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }
  res.json({ ok: true, revoked, currentRevoked: revoked.id === currentId });
}

export async function revokeOtherSessionsHandler(req, res) {
  const user = authenticatedUser(req);
  const currentId = signedPayload(req)?.sid || "";
  if (!currentId) return res.status(409).json({ error: "Sign in again before revoking other sessions" });
  const revoked = sessions.revokeOthers(user.id, currentId);
  await commitAuthGroups("sessions");
  res.json({ ok: true, revoked });
}

export async function updateUserHandler(req, res) {
  if (req.params.id === "creator") return res.status(400).json({ error: "The Creator account is managed through server configuration" });
  try {
    const previous = users.get(req.params.id);
    const user = users.update(req.params.id, req.body || {});
    if (!user) return res.status(404).json({ error: "User not found" });
    const changes = [];
    if (previous?.role !== user.role) changes.push(`role ${previous.role} -> ${user.role}`);
    if (previous?.disabled !== user.disabled) changes.push(user.disabled ? "account disabled" : "account enabled");
    if (previous?.approved !== user.approved) changes.push(user.approved ? "account approved" : "approval revoked");
    if (changes.length) sessions.removeUser(user.id);
    await commitAuthGroups("users", ...(changes.length ? ["sessions"] : []));
    if (changes.length) governance.recordAudit("account.update", req.user?.name, user.id, changes.join("; "));
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code });
  }
}

// Simple in-memory rate limiter (per-IP sliding window).
export function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || "unknown";
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(ip, arr);
    if (hits.size > 5000) hits.clear(); // crude cap
    if (arr.length > max) return res.status(429).json({ error: "rate limited" });
    next();
  };
}
