import httpProxy from "http-proxy";

import { config } from "../config.js";

const SIGNAL_PATH = "/rtc";

export function isLiveKitSignalPath(url = "/") {
  const path = new URL(url, "http://agentic-os.local").pathname;
  return path === SIGNAL_PATH || path.startsWith(`${SIGNAL_PATH}/`);
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

export function mountLiveKitProxy(app, server, proxy = createLiveKitProxy()) {
  app.use((req, res, next) => {
    if (!isLiveKitSignalPath(req.originalUrl || req.url)) return next();
    proxy.web(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!isLiveKitSignalPath(req.url)) return;
    proxy.ws(req, socket, head);
  });

  return proxy;
}
