import httpProxy from "http-proxy";
import http from "node:http";

import { config } from "../config.js";
import { authenticatedUser, requireRoles } from "./auth.js";

const PREFIX = "/hermes";

const ABSOLUTE_HERMES_PATHS = /(?<attr>\b(?:src|href|action)=["'])\/(?<path>(?:assets|api|favicon\.ico|manifest\.webmanifest|robots\.txt)\b[^"']*)/g;
const CSS_ABSOLUTE_URLS = /url\(["']?\/(?<path>(?:assets|favicon\.ico)\b[^)"']*)["']?\)/g;
const ASSET_ABSOLUTE_STRINGS = /(?<quote>["'`])\/(?<path>(?:assets|api|favicon\.ico|manifest\.webmanifest|robots\.txt)\b[^"'`]*)\k<quote>/g;

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

export function rewriteHermesDashboardHtml(html = "") {
  return String(html)
    .replace(ABSOLUTE_HERMES_PATHS, `$<attr>${PREFIX}/$<path>`)
    .replace(CSS_ABSOLUTE_URLS, `url("${PREFIX}/$<path>")`)
    .replace(/window\.__HERMES_BASE_PATH__="[^"]*"/g, `window.__HERMES_BASE_PATH__="${PREFIX}"`);
}

export function rewriteHermesDashboardAsset(text = "") {
  return String(text)
    .replace(CSS_ABSOLUTE_URLS, `url("${PREFIX}/$<path>")`)
    .replace(ASSET_ABSOLUTE_STRINGS, `$<quote>${PREFIX}/$<path>$<quote>`);
}

function prepareProxyRequest(proxyReq, req) {
  const { proto, host, origin } = hermesForwardedHeaders(req);
  proxyReq.setHeader("X-Forwarded-Prefix", PREFIX);
  proxyReq.setHeader("X-Forwarded-Proto", proto);
  proxyReq.setHeader("Accept-Encoding", "identity");
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
    selfHandleResponse: true,
  });

  proxy.on("proxyReq", prepareProxyRequest);
  proxy.on("proxyReqWs", prepareProxyRequest);
  proxy.on("proxyRes", (proxyRes, req, res) => {
    const headers = { ...proxyRes.headers };
    if (headers.location && String(headers.location).startsWith("/")) {
      headers.location = `${PREFIX}${headers.location}`;
    }
    delete headers["x-frame-options"];
    delete headers["content-security-policy"];

    const type = String(headers["content-type"] || "");
    const pathname = new URL(req.originalUrl || req.url || "/", "http://agentic-os.local").pathname;
    const rewritablePath = /\.(?:js|css|json|webmanifest)$/i.test(pathname);
    const rewritable = type.includes("text/html")
      || type.includes("javascript")
      || type.includes("text/css")
      || type.includes("application/json")
      || type.includes("manifest+json")
      || rewritablePath;
    if (!rewritable) {
      res.writeHead(proxyRes.statusCode || 502, headers);
      proxyRes.pipe(res);
      return;
    }

    const chunks = [];
    proxyRes.on("data", (chunk) => chunks.push(chunk));
    proxyRes.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = type.includes("text/html")
        ? rewriteHermesDashboardHtml(raw)
        : rewriteHermesDashboardAsset(raw);
      delete headers["content-length"];
      delete headers["content-encoding"];
      headers["content-type"] = type || "text/html; charset=utf-8";
      headers["content-length"] = Buffer.byteLength(body);
      res.writeHead(proxyRes.statusCode || 200, headers);
      res.end(body);
    });
  });
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
