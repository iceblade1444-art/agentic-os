// Official Higgsfield MCP connector (https://mcp.higgsfield.ai/mcp).
// No API keys: the user signs in with their Higgsfield account via OAuth
// (dynamic client registration + PKCE, handled by the MCP SDK). The registered
// client and tokens persist in DATA_DIR/higgsfield-mcp.json.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";

const storeFile = () => path.join(path.resolve(config.dataDir), "higgsfield-mcp.json");

function readStore() {
  try { return JSON.parse(fs.readFileSync(storeFile(), "utf8")); } catch { return {}; }
}

function writeStore(patch) {
  const data = { ...readStore(), ...patch };
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  const temporary = `${storeFile()}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, storeFile());
  hardenRuntimeFile(storeFile(), 0o600);
}

let pendingAuthUrl = "";
let live = null; // { client, transport, tools }

const redirectUrl = () => `${config.publicUrl}/api/studio/higgsfield/oauth/callback`;

// OAuthClientProvider for the MCP SDK. redirectToAuthorization cannot open a
// browser on the server, so it records the URL for the API layer to hand to
// the frontend, which opens it in the user's own browser tab.
export const oauthProvider = {
  get redirectUrl() { return redirectUrl(); },
  get clientMetadata() {
    return {
      client_name: "Agentic OS Studio",
      redirect_uris: [redirectUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  },
  state: () => crypto.randomUUID(),
  clientInformation: () => readStore().clientInformation,
  saveClientInformation: (clientInformation) => writeStore({ clientInformation }),
  tokens: () => readStore().tokens,
  saveTokens: (tokens) => writeStore({ tokens }),
  redirectToAuthorization: (url) => { pendingAuthUrl = url.toString(); },
  saveCodeVerifier: (codeVerifier) => writeStore({ codeVerifier }),
  codeVerifier: () => readStore().codeVerifier || "",
  invalidateCredentials: (scope) => {
    if (scope === "all") writeStore({ clientInformation: undefined, tokens: undefined, codeVerifier: undefined });
    else if (scope === "client") writeStore({ clientInformation: undefined });
    else if (scope === "tokens") writeStore({ tokens: undefined });
    else if (scope === "verifier") writeStore({ codeVerifier: undefined });
  },
};

export function higgsfieldMcpAuthorized() {
  return !!readStore().tokens;
}

export async function connectHiggsfieldMcp() {
  if (live) return live;
  pendingAuthUrl = "";
  const transport = new StreamableHTTPClientTransport(new URL(config.higgsfield.mcpUrl), { authProvider: oauthProvider });
  const client = new Client({ name: "agentic-os-studio", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (error) {
    try { await client.close(); } catch { /* already broken */ }
    if (error instanceof UnauthorizedError) {
      throw Object.assign(new Error("Higgsfield authorization required"), {
        status: 401, code: "higgsfield_auth_required", authUrl: pendingAuthUrl,
      });
    }
    throw Object.assign(new Error(`Higgsfield MCP connection failed: ${error.message}`), { status: 502 });
  }
  const listed = await client.listTools();
  live = { client, transport, tools: (listed.tools || []).map((tool) => tool.name) };
  return live;
}

export async function finishHiggsfieldAuth(code) {
  const transport = new StreamableHTTPClientTransport(new URL(config.higgsfield.mcpUrl), { authProvider: oauthProvider });
  await transport.finishAuth(code);
  try { await transport.close(); } catch { /* nothing to close yet */ }
  await disconnectHiggsfieldMcp();
}

export async function disconnectHiggsfieldMcp({ forget = false } = {}) {
  if (live) {
    try { await live.client.close(); } catch { /* ignore */ }
    live = null;
  }
  if (forget) writeStore({ tokens: undefined, codeVerifier: undefined });
}

export async function callHiggsfieldTool(name, args) {
  const entry = await connectHiggsfieldMcp();
  try {
    return await entry.client.callTool({ name, arguments: args });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      await disconnectHiggsfieldMcp();
      throw Object.assign(new Error("Higgsfield session expired — sign in again"), {
        status: 401, code: "higgsfield_auth_required",
      });
    }
    throw error;
  }
}

// ---- result parsing (MCP tools return prose/JSON text blocks) ----

export function contentText(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .map((item) => (typeof item?.text === "string" ? item.text : "")).filter(Boolean).join("\n");
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const URL_RE = /https?:\/\/[^\s<>"'`\\)\]]+/gi;

export function extractJobIds(text) {
  return [...new Set([...String(text).matchAll(UUID_RE)].map((match) => match[0].toLowerCase()))];
}

export function extractMediaUrls(text) {
  return [...new Set([...String(text).matchAll(URL_RE)]
    .map((match) => match[0].replace(/[),.;'"]+$/, ""))
    .filter((url) => !/higgsfield\.ai\/(mcp|requests)|oauth|token/i.test(url)))];
}

export async function mcpGenerateImage(input) {
  const params = { model: input.model, prompt: input.prompt };
  if (input.aspectRatio) params.aspect_ratio = input.aspectRatio;
  const result = await callHiggsfieldTool("generate_image", { params });
  const text = contentText(result);
  if (result?.isError) {
    throw Object.assign(new Error(text.slice(0, 500) || "Higgsfield MCP generation failed"), { status: 502 });
  }
  const jobId = extractJobIds(text)[0];
  if (!jobId) throw Object.assign(new Error("Higgsfield MCP did not return a job id"), { status: 502 });
  return { requestId: jobId, model: input.model };
}

export async function mcpPollJob(jobId) {
  const result = await callHiggsfieldTool("jobs_wait", {
    jobs: [{ index: 0, job_id: jobId }],
    timeout_seconds: 0,
  });
  const text = contentText(result);
  const failed = /\b(failed|error|nsfw|rejected|canceled|cancelled)\b/i.test(text);
  const done = !failed && /\b(completed|succeeded|success|done|finished)\b/i.test(text);
  const urls = extractMediaUrls(text);
  return {
    status: done ? "completed" : failed ? "failed" : "in_progress",
    done,
    failed,
    outputUrl: urls[0] || "",
    images: urls,
    error: failed ? text.replace(/\s+/g, " ").trim().slice(0, 500) : "",
  };
}
