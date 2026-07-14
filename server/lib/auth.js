// Minimal, dependency-free auth: a single admin token (AUTH_TOKEN). Browser logs in
// and gets an HMAC-signed, httpOnly session cookie; API clients (the MCP bridge) may
// send `Authorization: Bearer <AUTH_TOKEN>`. When AUTH_TOKEN is unset, auth is
// disabled (local dev) — the server logs a warning at startup.
import crypto from "node:crypto";
import { config } from "../config.js";

const COOKIE = "aos_session";
const b64 = (buf) => Buffer.from(buf).toString("base64url");

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

export function isAuthed(req) {
  if (!authEnabled()) return true;
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ") && constEq(auth.slice(7), config.authToken)) return true;
  return !!verify(parseCookies(req)[COOKIE]);
}

export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "unauthorized" });
}

function sessionCookie(req) {
  const token = sign({ exp: Date.now() + 7 * 864e5 });
  const secure = config.secureCookie || req.secure ? "; Secure" : "";
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}${secure}`;
}

export function loginHandler(req, res) {
  if (!authEnabled()) return res.json({ ok: true, required: false });
  const password = (req.body || {}).password || "";
  if (!constEq(password, config.authToken)) return res.status(401).json({ error: "Invalid password" });
  res.setHeader("Set-Cookie", sessionCookie(req));
  res.json({ ok: true });
}
export function logoutHandler(req, res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
}
export function meHandler(req, res) {
  res.json({ required: authEnabled(), authed: isAuthed(req) });
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
