import httpProxy from "http-proxy";
import http from "node:http";

import { config } from "../config.js";
import { authenticatedUser, requireRoles } from "./auth.js";

const PREFIX = "/hermes";

export function stripHermesPrefix(url = "/") {
  const stripped = url.replace(/^\/hermes(?=\/|\?|$)/, "");
  return stripped || "/";
}

export function isBareHermesRequest(method, url) {
  return method === "GET" && String(url || "").split("?", 1)[0] === PREFIX;
}

export function hasHermesAccess(req) {
  return ["Creator", "Admin"].includes(authenticatedUser(req)?.role);
}

export function hermesForwardedHeaders(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const origin = req.headers.origin ? "http://127.0.0.1:9119" : "";
  return { proto, host, origin };
}

function prepareProxyRequest(proxyReq, req) {
  const { proto, host, origin } = hermesForwardedHeaders(req);
  proxyReq.setHeader("X-Forwarded-Prefix", PREFIX);
  proxyReq.setHeader("X-Forwarded-Proto", proto);
  if (host) proxyReq.setHeader("X-Forwarded-Host", host);
  // Hermes is deliberately loopback-only and validates WS/POST origins. The
  // public origin was already authenticated by Agentic OS before this hop.
  if (origin) proxyReq.setHeader("Origin", origin);
}

function rejectUpgrade(socket, status = "401 Unauthorized") {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createHermesProxy() {
  const target = config.hermesDashboardSocket
    ? { protocol: "http:", host: "localhost", hostname: "localhost", socketPath: config.hermesDashboardSocket }
    : config.hermesDashboardUrl;
  const proxy = httpProxy.createProxyServer({
    target,
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
  app.use((req, res, next) => {
    if (isBareHermesRequest(req.method, req.originalUrl || req.url)) {
      return requireRoles("Creator", "Admin")(req, res, () => res.redirect(302, `${PREFIX}/`));
    }
    next();
  });
  app.use(PREFIX, requireRoles("Creator", "Admin"), (req, res) => {
    req.url = stripHermesPrefix(req.originalUrl || req.url);
    proxy.web(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url || "/", "http://agentic-os.local").pathname;
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return;
    if (!hasHermesAccess(req)) return rejectUpgrade(socket, "403 Forbidden");
    req.url = stripHermesPrefix(req.url);
    proxy.ws(req, socket, head);
  });

  return proxy;
}

export async function hermesDashboardStatus(fetchImpl = fetch, options = {}) {
  const checkedAt = new Date().toISOString();
  const socketPath = options.socketPath ?? config.hermesDashboardSocket;
  const dashboardUrl = options.dashboardUrl ?? config.hermesDashboardUrl;
  try {
    let status;
    if (socketPath) {
      status = await new Promise((resolve, reject) => {
        const request = http.request({
          socketPath,
          path: "/",
          method: "GET",
          headers: { Host: "127.0.0.1:9119" },
          timeout: 3000,
        }, (response) => {
          response.resume();
          resolve(response.statusCode || 0);
        });
        request.on("timeout", () => request.destroy(new Error("Hermes Dashboard probe timed out")));
        request.on("error", reject);
        request.end();
      });
    } else {
      const response = await fetchImpl(`${dashboardUrl}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
        headers: { Host: new URL(dashboardUrl).host },
      });
      status = response.status;
    }
    return {
      configured: true,
      ready: status >= 200 && status < 500,
      status,
      url: PREFIX + "/",
      checkedAt,
    };
  } catch (error) {
    return { configured: true, ready: false, status: 0, url: PREFIX + "/", checkedAt, error: error.message };
  }
}
