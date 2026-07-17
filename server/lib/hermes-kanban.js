import http from "node:http";

import { config } from "../config.js";

const API_PREFIX = "/api/plugins/kanban";
let cachedToken = "";

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
        response.on("end", () => resolve({
          status: response.statusCode || 0,
          text: Buffer.concat(chunks).toString("utf8"),
        }));
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
  }).then(async (response) => ({ status: response.status, text: await response.text() }));
}

async function sessionToken(force = false, requestImpl = dashboardRequest) {
  if (cachedToken && !force) return cachedToken;
  const response = await requestImpl("/");
  if (response.status < 200 || response.status >= 400) throw new Error(`Hermes Dashboard HTTP ${response.status}`);
  const token = response.text.match(/__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/)?.[1];
  if (!token) throw new Error("Hermes Dashboard session token is unavailable");
  cachedToken = token;
  return token;
}

export function withKanbanBoard(pathname, board = config.hermesKanbanBoard) {
  const url = new URL(pathname, "http://kanban.local");
  url.searchParams.set("board", board);
  return `${url.pathname}${url.search}`;
}

export async function hermesKanbanRequest(pathname, options = {}, requestImpl = dashboardRequest) {
  if (!String(pathname).startsWith(`${API_PREFIX}/`)) throw new Error("Invalid Hermes Kanban path");
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const run = async (forceToken = false) => {
    const token = await sessionToken(forceToken, requestImpl);
    return requestImpl(pathname, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
      body: payload,
    });
  };

  let response = await run(false);
  if (response.status === 401 || response.status === 403) response = await run(true);
  let data;
  try { data = response.text ? JSON.parse(response.text) : {}; }
  catch { data = {}; }
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(data.detail || data.error || `Hermes Kanban HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export const kanbanPath = (suffix, board) => withKanbanBoard(`${API_PREFIX}${suffix}`, board);

export function resetHermesKanbanToken() {
  cachedToken = "";
}
