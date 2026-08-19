// DeepSeek Harness behind Agentic OS auth.
//
// dsh serves its own full web UI, but deliberately binds 127.0.0.1 and trusts
// only its loopback authority — the CLI refuses --host 0.0.0.0. The container
// (deploy/dsh) relays that loopback onto the docker network as dsh:3081, and
// this proxy is the only public way in: same pattern as Hermes Control, an
// operator-authenticated prefix with the upstream's UI embedded verbatim.
//
// The Host and Origin headers are rewritten to the loopback authority dsh
// actually trusts: whoever reached this proxy already passed Agentic OS auth,
// so the browser-trust fence's job is done before the hop.

import httpProxy from "http-proxy";

import { config } from "../config.js";
import { authenticatedUser, requireRoles } from "./auth.js";

const PREFIX = "/dsh";
const LOOPBACK_AUTHORITY = "127.0.0.1:3080";

// dsh's UI assumes it lives at the origin root: the HTML links /assets and
// /favicon.svg, the boot manifest carries "/plugins/..." URLs inside JSON, and
// the connection plugin hardcodes "/api/events.mux" and friends in its bundle.
// Every such absolute string moves under /dsh; Vite's lazy chunks resolve
// relative to their importing module's URL and need no help.
const DSH_ROOTS = "(?:api|plugins|assets|favicon\\.svg|manifest\\.webmanifest)";
const ATTRIBUTE_PATHS = new RegExp(`(?<attr>\\b(?:src|href|action)=["'])/(?<path>${DSH_ROOTS}(?:[^"']*)?)`, "g");
const QUOTED_PATHS = new RegExp(`(?<quote>["'\`])/(?<path>${DSH_ROOTS}(?:[/?#][^"'\`]*)?)\\k<quote>`, "g");
const CSS_ABSOLUTE_URLS = new RegExp(`url\\(["']?/(?<path>${DSH_ROOTS}[^)"']*)["']?\\)`, "g");

export function stripDshPrefix(url = "/") {
  const stripped = url.replace(/^\/dsh(?=\/|\?|$)/, "");
  return stripped || "/";
}

export function isBareDshRequest(method, url) {
  return method === "GET" && String(url || "").split("?", 1)[0] === PREFIX;
}

export function hasDshAccess(req) {
  return ["Creator", "Admin", "CEO"].includes(authenticatedUser(req)?.role);
}

export function rewriteDshHtml(html = "") {
  return String(html)
    .replace(ATTRIBUTE_PATHS, `$<attr>${PREFIX}/$<path>`)
    .replace(QUOTED_PATHS, `$<quote>${PREFIX}/$<path>$<quote>`)
    .replace(CSS_ABSOLUTE_URLS, `url("${PREFIX}/$<path>")`);
}

export function rewriteDshAsset(text = "") {
  return String(text)
    .replace(QUOTED_PATHS, `$<quote>${PREFIX}/$<path>$<quote>`)
    .replace(CSS_ABSOLUTE_URLS, `url("${PREFIX}/$<path>")`);
}

function prepareProxyRequest(proxyReq) {
  proxyReq.setHeader("Host", LOOPBACK_AUTHORITY);
  proxyReq.setHeader("Origin", `http://${LOOPBACK_AUTHORITY}`);
  proxyReq.setHeader("Accept-Encoding", "identity");
}

function rejectUpgrade(socket, status = "401 Unauthorized") {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createDshProxy(options = {}) {
  const proxy = httpProxy.createProxyServer({
    target: options.target || config.dshUrl,
    ws: true,
    selfHandleResponse: true,
  });

  proxy.on("proxyReq", prepareProxyRequest);
  proxy.on("proxyReqWs", prepareProxyRequest);
  proxy.on("proxyRes", (proxyRes, req, res) => {
    const headers = { ...proxyRes.headers };
    // dsh streams chunked responses. We re-frame the body ourselves (rewritten
    // bodies get a content-length, piped ones get Node's own chunking), so the
    // upstream's framing headers must not ride along: content-length next to
    // transfer-encoding is malformed HTTP, and the openresty in front of the
    // site answers it with a hard 502.
    delete headers["transfer-encoding"];
    delete headers.connection;
    if (headers.location && String(headers.location).startsWith("/")) {
      headers.location = `${PREFIX}${headers.location}`;
    }
    // The page must be embeddable in the Agentic OS tab's iframe.
    delete headers["x-frame-options"];
    delete headers["content-security-policy"];

    const type = String(headers["content-type"] || "");
    const pathname = new URL(req.originalUrl || req.url || "/", "http://agentic-os.local").pathname;
    const rewritable = type.includes("text/html")
      || type.includes("javascript")
      || type.includes("text/css")
      || type.includes("application/json")
      || type.includes("manifest+json")
      || /\.(?:js|css|json|webmanifest)$/i.test(pathname);
    if (!rewritable) {
      res.writeHead(proxyRes.statusCode || 502, headers);
      proxyRes.pipe(res);
      return;
    }

    const chunks = [];
    proxyRes.on("data", (chunk) => chunks.push(chunk));
    proxyRes.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = type.includes("text/html") ? rewriteDshHtml(raw) : rewriteDshAsset(raw);
      delete headers["content-length"];
      delete headers["content-encoding"];
      headers["content-type"] = type || "text/html; charset=utf-8";
      headers["content-length"] = Buffer.byteLength(body);
      res.writeHead(proxyRes.statusCode || 200, headers);
      res.end(body);
    });
  });
  proxy.on("error", (error, req, resOrSocket) => {
    console.error("[dsh-proxy]", error.message);
    if (typeof resOrSocket?.writeHead === "function") {
      if (!resOrSocket.headersSent) {
        resOrSocket.writeHead(503, { "Content-Type": "application/json" });
        resOrSocket.end(JSON.stringify({ error: "DeepSeek Harness is unavailable" }));
      }
      return;
    }
    resOrSocket?.destroy?.();
  });

  return proxy;
}

export function mountDshProxy(app, server, proxy = createDshProxy()) {
  app.use((req, res, next) => {
    if (isBareDshRequest(req.method, req.originalUrl || req.url)) {
      return requireRoles("Creator", "Admin", "CEO")(req, res, () => res.redirect(302, `${PREFIX}/`));
    }
    next();
  });
  app.use(PREFIX, requireRoles("Creator", "Admin", "CEO"), (req, res) => {
    req.url = stripDshPrefix(req.originalUrl || req.url);
    proxy.web(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url || "/", "http://agentic-os.local").pathname;
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return;
    if (!hasDshAccess(req)) return rejectUpgrade(socket, "403 Forbidden");
    req.url = stripDshPrefix(req.url);
    proxy.ws(req, socket, head);
  });

  return proxy;
}

export async function dshStatus(fetchImpl = fetch, options = {}) {
  const checkedAt = new Date().toISOString();
  const url = options.dshUrl ?? config.dshUrl;
  try {
    const response = await fetchImpl(`${url}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
      headers: { Host: LOOPBACK_AUTHORITY },
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
