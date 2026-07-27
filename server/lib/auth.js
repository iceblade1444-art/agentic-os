// Minimal, dependency-free auth: a single admin token (AUTH_TOKEN). Browser logs in
// and gets an HMAC-signed, httpOnly session cookie; API clients (the MCP bridge) may
// send `Authorization: Bearer <AUTH_TOKEN>`. When AUTH_TOKEN is unset, auth is
// disabled (local dev) — the server logs a warning at startup.
import crypto from "node:crypto";
import { config } from "../config.js";
import { governance } from "./governance.js";
import { users } from "./users.js";

const COOKIE = "aos_session";
const b64 = (buf) => Buffer.from(buf).toString("base64url");
const usedPairingGrants = new Map();

export function authEnabled() { return !!config.authToken; }

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
    if (payload.user.id === "creator") return creatorUser();
    const user = users.sessionUser(String(payload.user.id));
    if (!user || Number(payload.sessionVersion) !== user.sessionVersion) return null;
    return userFromSession({ user });
  }
  const payload = verify(parseCookies(req)[COOKIE]);
  if (!payload?.user) return null;
  if (payload.user.id === "creator") return creatorUser();
  const user = users.sessionUser(String(payload.user.id || ""));
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
  return requireRoles("Creator", "Admin", "Member")(req, res, next);
}

export function capabilities(user) {
  const role = user?.role || "Viewer";
  return {
    canWrite: ["Creator", "Admin", "Member"].includes(role),
    canAdmin: ["Creator", "Admin"].includes(role),
    canManageUsers: ["Creator", "Admin"].includes(role),
  };
}

export function sessionCookie(req, user = creatorUser()) {
  const token = sign({ exp: Date.now() + 7 * 864e5, user: userFromSession({ user }), sessionVersion: Number(user.sessionVersion) || 1 });
  const secure = config.secureCookie || req.secure ? "; Secure" : "";
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}${secure}`;
}

export function mobileSessionToken(user) {
  return sign({
    exp: Date.now() + 30 * 864e5,
    kind: "mobile",
    user: userFromSession({ user }),
    sessionVersion: Number(user.sessionVersion) || 1,
  });
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
  const user = users.sessionUser(String(payload.user.id));
  if (!user || Number(payload.sessionVersion) !== user.sessionVersion) return null;
  return user;
}

export function mobilePairExchangeHandler(req, res) {
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
  res.json({
    ok: true,
    accessToken: mobileSessionToken(user),
    expiresInSeconds: 30 * 86400,
    user: userFromSession({ user }),
    capabilities: capabilities(user),
  });
}

export function loginHandler(req, res) {
  if (!authEnabled()) return res.json({ ok: true, required: false, user: creatorUser() });
  const { email = "", password = "" } = req.body || {};
  const user = email ? users.authenticate(email, password) : (constEq(password, config.authToken) ? creatorUser() : null);
  if (!user) return res.status(401).json({ error: "Invalid email or password" });
  res.setHeader("Set-Cookie", sessionCookie(req, user));
  res.json({ ok: true, user: userFromSession({ user }), capabilities: capabilities(user) });
}
export function registerHandler(req, res) {
  if (!config.allowRegistration) return res.status(403).json({ error: "Registration is disabled" });
  try {
    const user = users.register(req.body || {});
    res.setHeader("Set-Cookie", sessionCookie(req, user));
    res.status(201).json({ ok: true, user: userFromSession({ user }), capabilities: capabilities(user) });
  } catch (error) {
    res.status(error.code === "email_exists" ? 409 : 400).json({ error: error.message, code: error.code });
  }
}

export function mobileLoginHandler(req, res) {
  if (!authEnabled()) return res.status(503).json({ error: "Authentication is not configured" });
  const { email = "", password = "" } = req.body || {};
  const user = email ? users.authenticate(email, password) : (constEq(password, config.authToken) ? creatorUser() : null);
  if (!user) return res.status(401).json({ error: "Invalid email or password" });
  res.json({
    ok: true,
    accessToken: mobileSessionToken(user),
    expiresInSeconds: 30 * 86400,
    user: userFromSession({ user }),
    capabilities: capabilities(user),
  });
}

export function mobileRegisterHandler(req, res) {
  if (!config.allowRegistration) return res.status(403).json({ error: "Registration is disabled" });
  try {
    const user = users.register(req.body || {});
    res.status(201).json({
      ok: true,
      accessToken: mobileSessionToken(user),
      expiresInSeconds: 30 * 86400,
      user: userFromSession({ user }),
      capabilities: capabilities(user),
    });
  } catch (error) {
    res.status(error.code === "email_exists" ? 409 : 400).json({ error: error.message, code: error.code });
  }
}
export function logoutHandler(req, res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
}
export function meHandler(req, res) {
  const user = authenticatedUser(req);
  res.json({ required: authEnabled(), registration: config.allowRegistration, authed: !!user, user, capabilities: capabilities(user) });
}

export function listUsersHandler(req, res) {
  res.json([creatorUser(), ...users.list()]);
}

export function updateUserHandler(req, res) {
  if (req.params.id === "creator") return res.status(400).json({ error: "The Creator account is managed through server configuration" });
  try {
    const previous = users.get(req.params.id);
    const user = users.update(req.params.id, req.body || {});
    if (!user) return res.status(404).json({ error: "User not found" });
    const changes = [];
    if (previous?.role !== user.role) changes.push(`role ${previous.role} -> ${user.role}`);
    if (previous?.disabled !== user.disabled) changes.push(user.disabled ? "account disabled" : "account enabled");
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
