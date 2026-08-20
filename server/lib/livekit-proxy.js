import httpProxy from "http-proxy";

import { config } from "../config.js";
import { isAuthed } from "./auth.js";

const SIGNAL_PATH = "/rtc";

export function isLiveKitSignalPath(url = "/") {
  const path = new URL(url, "http://agentic-os.local").pathname;
  return path === SIGNAL_PATH || path.startsWith(`${SIGNAL_PATH}/`);
}

// The proxy is mounted before the body parsers, which also puts it before
// requireAuth — so until this check existed, anyone on the internet could reach
// the LiveKit signalling server through our hostname. LiveKit's own room JWT
// still gates what a caller may do once inside; this gate stops unauthenticated
// traffic from getting that far, and keeps the transport off the public surface.
// Every signed-in role may call MILA Live, so identity is enough — no role list.
export function hasLiveKitAccess(req, authed = isAuthed) {
  return !!authed(req);
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
