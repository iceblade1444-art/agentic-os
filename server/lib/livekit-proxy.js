import crypto from "node:crypto";

import httpProxy from "http-proxy";

import { config } from "../config.js";
import { isAuthed } from "./auth.js";

const SIGNAL_PATH = "/rtc";

export function isLiveKitSignalPath(url = "/") {
  const path = new URL(url, "http://agentic-os.local").pathname;
  return path === SIGNAL_PATH || path.startsWith(`${SIGNAL_PATH}/`);
}

// A LiveKit room token, verified the same way LiveKit will verify it.
//
// The phone does not have a console session and never will: it authenticates
// against the MILA backend, a separate service with its own accounts, and that
// backend mints this token with the shared LiveKit secret. Holding a valid one
// therefore proves the caller was authorised by something that holds the
// secret — which is exactly the claim LiveKit checks a moment later. Accepting
// it here is no weaker than the transport behind it, and it still keeps
// unauthenticated traffic off the public surface, which is what the gate is for.
function verifiedRoomToken(req) {
  const secret = config.livekitApiSecret;
  // Not configured: fall back to session-only rather than opening up. A missing
  // secret must never be the reason something is let through.
  if (!secret) return false;

  const url = new URL(req.url || "/", "http://agentic-os.local");
  const header = String(req.headers?.authorization || "");
  const raw = url.searchParams.get("access_token")
    || (header.startsWith("Bearer ") ? header.slice(7) : "");
  const parts = String(raw).split(".");
  if (parts.length !== 3) return false;

  const [head, body, signature] = parts;
  const expected = crypto.createHmac("sha256", secret)
    .update(`${head}.${body}`).digest("base64url");
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  // A signature alone is not enough: an expired token is a token that was once
  // valid, and LiveKit would refuse it.
  if (typeof claims.exp !== "number" || claims.exp <= now) return false;
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) return false;
  if (config.livekitApiKey && claims.iss !== config.livekitApiKey) return false;
  // And it has to be a token for joining a room, not some other grant that
  // happens to be signed with the same secret.
  return claims.video?.roomJoin === true && typeof claims.video?.room === "string";
}

// The proxy is mounted before the body parsers, which also puts it before
// requireAuth — so until this check existed, anyone on the internet could reach
// the LiveKit signalling server through our hostname. This gate stops
// unauthenticated traffic from getting that far and keeps the transport off the
// public surface. Every signed-in role may call MILA Live, so identity is
// enough — no role list.
//
// Two ways in, because there are two kinds of caller: the console, which has a
// session here, and the phone, which has a room token instead.
export function hasLiveKitAccess(req, authed = isAuthed) {
  return !!authed(req) || verifiedRoomToken(req);
}

function rejectUpgrade(socket, status = "401 Unauthorized") {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createLiveKitProxy() {
  const proxy = httpProxy.createProxyServer({
    target: config.livekitUrl,
    changeOrigin: true,
    ws: true,
    xfwd: true,
  });
  proxy.on("error", (error, _req, resOrSocket) => {
    console.error("[livekit-proxy]", error.message);
    if (typeof resOrSocket?.writeHead === "function") {
      if (!resOrSocket.headersSent) {
        resOrSocket.writeHead(503, { "Content-Type": "application/json" });
        resOrSocket.end(JSON.stringify({ error: "MILA Live transport is unavailable" }));
      }
      return;
    }
    resOrSocket?.destroy?.();
  });
  return proxy;
}

// authed is a parameter with the real default so a test can prove the refusal
// path without minting a session — the same shape used across this codebase.
export function mountLiveKitProxy(app, server, proxy = createLiveKitProxy(), authed = isAuthed) {
  app.use((req, res, next) => {
    if (!isLiveKitSignalPath(req.originalUrl || req.url)) return next();
    if (!hasLiveKitAccess(req, authed)) return res.status(401).json({ error: "unauthorized" });
    proxy.web(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!isLiveKitSignalPath(req.url)) return;
    if (!hasLiveKitAccess(req, authed)) return rejectUpgrade(socket);
    proxy.ws(req, socket, head);
  });

  return proxy;
}
