import http from "node:http";

import { config } from "../config.js";

function socketRequest(pathname, { method = "GET", body, timeoutMs = 190000 } = {}) {
  if (!config.hermesChatSocket) throw Object.assign(new Error("Hermes text provider is not configured"), { status: 503 });
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: config.hermesChatSocket,
      path: pathname,
      method,
      timeout: timeoutMs,
      headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("timeout", () => request.destroy(new Error("Hermes text provider timed out")));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function parseResponse(response) {
  let data = {};
  try { data = response.text ? JSON.parse(response.text) : {}; } catch { /* handled below */ }
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(data.error || `Hermes text provider HTTP ${response.status}`);
    error.status = response.status || 502;
    throw error;
  }
  return data;
}

export async function hermesChatStatus(requestImpl = socketRequest) {
  const checkedAt = new Date().toISOString();
  if (!config.hermesChatSocket && requestImpl === socketRequest) return { configured: false, ready: false, checkedAt };
  try {
    const response = await requestImpl("/health", { timeoutMs: 3000 });
    const data = await parseResponse(response);
    return { configured: true, ready: data.ok === true, provider: data.provider || "hermes", mode: data.mode || "safe", checkedAt };
  } catch (error) {
    return { configured: true, ready: false, error: error.message, checkedAt };
  }
}

export async function hermesChatComplete(messages, options = {}, requestImpl = socketRequest) {
  const payload = JSON.stringify({
    messages: Array.isArray(messages) ? messages : [],
    timeoutSeconds: Math.max(30, Math.min(300, Number(options.timeoutSeconds) || 180)),
  });
  const data = await parseResponse(await requestImpl("/v1/chat/completions", {
    method: "POST", body: payload, timeoutMs: (Number(options.timeoutSeconds) || 180) * 1000 + 10000,
  }));
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Hermes text provider returned no content");
  return { text: String(text), model: data.model || "hermes/openai-codex" };
}
