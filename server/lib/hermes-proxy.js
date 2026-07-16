import httpProxy from "http-proxy";

import { config } from "../config.js";
import { isAuthed, requireAuth } from "./auth.js";

const PREFIX = "/hermes";

export function stripHermesPrefix(url = "/") {
  const stripped = url.replace(/^\/hermes(?=\/|\?|$)/, "");
  return stripped || "/";
}

function forwardedHeaders(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return { proto, host };
}

function prepareProxyRequest(proxyReq, req) {
  const { proto, host } = forwardedHeaders(req);
  proxyReq.setHeader("X-Forwarded-Prefix", PREFIX);
  proxyReq.setHeader("X-Forwarded-Proto", proto);
  if (host) proxyReq.setHeader("X-Forwarded-Host", host);
}

function rejectUpgrade(socket, status = "401 Unauthorized") {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createHermesProxy() {
  const proxy = httpProxy.createProxyServer({
    target: config.hermesDashboardUrl,
    changeOrigin: true,
    ws: true,
    xfwd: true,
  });

  proxy.on("proxyReq", prepareProxyRequest);
  proxy.on("proxyReqWs", prepareProxyRequest);
  proxy.on("error", (error, req, resOrSocket) => {
    console.error("[hermes-proxy]", error.message);
    if (typeof resOrSocket?.writeHead === "function") {
      if (!resOrSocket.headersSent) {
        resOrSocket.writeHead(503, { "Content-Type": "application/json" });
        resOrSocket.end(JSON.stringify({ error: "Hermes Dashboard is unavailable" }));
      }
      return;
    }
    resOrSocket?.destroy?.();
  });

  return proxy;
}

export function mountHermesProxy(app, server, proxy = createHermesProxy()) {
  app.get(PREFIX, requireAuth, (req, res) => res.redirect(302, `${PREFIX}/`));
  app.use(PREFIX, requireAuth, (req, res) => {
    req.url = stripHermesPrefix(req.originalUrl || req.url);
    proxy.web(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url || "/", "http://agentic-os.local").pathname;
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return rejectUpgrade(socket, "404 Not Found");
    if (!isAuthed(req)) return rejectUpgrade(socket);
    req.url = stripHermesPrefix(req.url);
    proxy.ws(req, socket, head);
  });

  return proxy;
}

export async function hermesDashboardStatus(fetchImpl = fetch) {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetchImpl(`${config.hermesDashboardUrl}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
      headers: { Host: new URL(config.hermesDashboardUrl).host },
    });
    return {
      configured: true,
      ready: response.status >= 200 && response.status < 500,
      status: response.status,
      url: PREFIX + "/",
      checkedAt,
    };
  } catch (error) {
    return { configured: true, ready: false, status: 0, url: PREFIX + "/", checkedAt, error: error.message };
  }
}
