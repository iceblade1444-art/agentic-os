import http from "node:http";

import { config } from "../config.js";

const API_PREFIX = "/api/plugins/kanban";
let cachedToken = "";
let cachedCookies = "";

function dashboardRequest(pathname, { method = "GET", headers = {}, body, timeoutMs = 8000 } = {}) {
  if (config.hermesDashboardSocket) {
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: config.hermesDashboardSocket,
        path: pathname,
        method,
        timeout: timeoutMs,
        headers: { Host: "127.0.0.1:9119", ...headers },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: response.statusCode || 0,
            text: body.toString("utf8"),
            body,
            headers: response.headers,
          });
        });
      });
      request.on("timeout", () => request.destroy(new Error("Hermes Kanban request timed out")));
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
  }

  return fetch(new URL(pathname, `${config.hermesDashboardUrl}/`), {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (response) => {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      text: buffer.toString("utf8"),
      body: buffer,
      headers: Object.fromEntries(response.headers.entries()),
    };
  });
}

const TOKEN_IN_PAGE = /__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/;

// The dashboard hands its session token to whoever loads its page. Since the
// June-2026 hardening it only does that for a signed-in caller, so an
// anonymous GET / comes back as a 302 to /login and the bridge is locked out
// of Kanban, Routines and Skills. Logging in is the supported way through:
// POST /auth/password-login mints the session cookies the page needs.
//
// Credentials are optional on purpose — a dashboard with no auth provider
// still works exactly as before, and one with auth says plainly what is
// missing instead of failing as "token unavailable".
function loginCookies(response) {
  const raw = response.headers?.["set-cookie"] || response.headers?.["Set-Cookie"] || [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((entry) => String(entry).split(";")[0].trim()).filter(Boolean).join("; ");
}

async function logIn(requestImpl) {
  const { hermesDashboardUsername: username, hermesDashboardPassword: password } = config;
  if (!username || !password) {
    throw new Error("Hermes Dashboard requires a sign-in; set HERMES_DASHBOARD_USERNAME and HERMES_DASHBOARD_PASSWORD");
  }
  const body = JSON.stringify({ provider: "basic", username, password });
  const response = await requestImpl("/auth/password-login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    body,
  });
  // The login route is rate limited, so a refusal is reported, never retried.
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Hermes Dashboard sign-in failed (HTTP ${response.status})`);
  }
  const cookies = loginCookies(response);
  if (!cookies) throw new Error("Hermes Dashboard sign-in returned no session cookie");
  return cookies;
}

async function sessionToken(force = false, requestImpl = dashboardRequest) {
  if (cachedToken && !force) return cachedToken;
  let response = await requestImpl("/", cachedCookies ? { headers: { Cookie: cachedCookies } } : {});
  let token = response.status >= 200 && response.status < 400 ? response.text.match(TOKEN_IN_PAGE)?.[1] : null;
  if (!token) {
    // Either the page never had a token or this caller is not signed in.
    cachedCookies = await logIn(requestImpl);
    response = await requestImpl("/", { headers: { Cookie: cachedCookies } });
    if (response.status < 200 || response.status >= 400) throw new Error(`Hermes Dashboard HTTP ${response.status}`);
    token = response.text.match(TOKEN_IN_PAGE)?.[1];
  }
  if (!token) throw new Error("Hermes Dashboard session token is unavailable");
  cachedToken = token;
  return token;
}

async function authorizedDashboardRequest(pathname, options = {}, requestImpl = dashboardRequest) {
  const run = async (forceToken = false) => {
    const token = await sessionToken(forceToken, requestImpl);
    return requestImpl(pathname, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(cachedCookies ? { Cookie: cachedCookies } : {}),
        ...(options.headers || {}),
      },
      body: options.body,
      timeoutMs: options.timeoutMs,
    });
  };
  let response = await run(false);
  if (response.status === 401 || response.status === 403) {
    cachedCookies = "";
    response = await run(true);
  }
  if (response.status < 200 || response.status >= 300) {
    let data;
    try { data = response.text ? JSON.parse(response.text) : {}; }
    catch { data = {}; }
    const error = new Error(data.detail || data.error || `Hermes Dashboard HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

export function withKanbanBoard(pathname, board = config.hermesKanbanBoard) {
  const url = new URL(pathname, "http://kanban.local");
  url.searchParams.set("board", board);
  return `${url.pathname}${url.search}`;
}

export async function hermesKanbanRawRequest(pathname, options = {}, requestImpl = dashboardRequest) {
  if (!String(pathname).startsWith(`${API_PREFIX}/`)) throw new Error("Invalid Hermes Kanban path");
  return authorizedDashboardRequest(pathname, options, requestImpl);
}

export async function hermesKanbanRequest(pathname, options = {}, requestImpl = dashboardRequest) {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await hermesKanbanRawRequest(pathname, {
    method: options.method,
    headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
    body: payload,
    timeoutMs: options.timeoutMs,
  }, requestImpl);
  let data;
  try { data = response.text ? JSON.parse(response.text) : {}; }
  catch { data = {}; }
  return data;
}

export const kanbanPath = (suffix, board) => withKanbanBoard(`${API_PREFIX}${suffix}`, board);

export async function hermesSkillsRequest(pathname, options = {}, requestImpl = dashboardRequest) {
  const value = String(pathname || "");
  if (value !== "/api/skills" && !value.startsWith("/api/skills/") && !value.startsWith("/api/skills?")) {
    throw new Error("Invalid Hermes Skills path");
  }
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await authorizedDashboardRequest(value, {
    method: options.method,
    headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
    body: payload,
    timeoutMs: options.timeoutMs || 12000,
  }, requestImpl);
  let data;
  try { data = response.text ? JSON.parse(response.text) : {}; }
  catch { throw new Error("Hermes Skills returned invalid JSON"); }
  return data;
}

export async function hermesCronRequest(pathname, options = {}, requestImpl = dashboardRequest) {
  const value = String(pathname || "");
  if (value !== "/api/cron" && !value.startsWith("/api/cron/") && !value.startsWith("/api/cron?")) {
    throw new Error("Invalid Hermes Cron path");
  }
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await authorizedDashboardRequest(value, {
    method: options.method,
    headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
    body: payload,
    timeoutMs: options.timeoutMs || 15000,
  }, requestImpl);
  let data;
  try { data = response.text ? JSON.parse(response.text) : {}; }
  catch { throw new Error("Hermes Cron returned invalid JSON"); }
  return data;
}

export function resetHermesKanbanToken() {
  cachedToken = "";
}

// A seam for the tests: the module caches a session across calls and reads
// its credentials from config, so a test needs to be able to clear the one
// and stand in for the other.
export const __testing = {
  sessionToken,
  reset() { cachedToken = ""; cachedCookies = ""; },
  setCredentials({ username, password }) {
    config.hermesDashboardUsername = username;
    config.hermesDashboardPassword = password;
  },
};
