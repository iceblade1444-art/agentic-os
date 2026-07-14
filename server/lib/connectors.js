// Integration connectors — real credential-based checks against each provider.
import { config } from "../config.js";
import { milaStatus } from "./mila.js";

export const PROVIDERS = {
  openai: { name: "OpenAI", desc: "GPT-4o, GPT-4o mini, embeddings", icon: "sparkles", color: "green",
    fields: [{ key: "apiKey", label: "API Key", secret: true }, { key: "baseUrl", label: "Base URL (optional)" }] },
  anthropic: { name: "Anthropic", desc: "Claude Opus, Sonnet, Haiku", icon: "brain", color: "amber",
    fields: [{ key: "apiKey", label: "API Key", secret: true }] },
  github: { name: "GitHub", desc: "Repos, issues, pull requests", icon: "code", color: "violet",
    fields: [{ key: "token", label: "Personal Access Token", secret: true }] },
  notion: { name: "Notion", desc: "Docs & knowledge base", icon: "file", color: "cyan",
    fields: [{ key: "token", label: "Integration Token", secret: true }] },
  slack: { name: "Slack", desc: "Send notifications & alerts", icon: "chat", color: "pink",
    fields: [{ key: "webhookUrl", label: "Incoming Webhook URL", secret: true }] },
  postgres: { name: "Postgres", desc: "SQL database connector", icon: "database", color: "blue",
    fields: [{ key: "connectionString", label: "Connection string", secret: true }] },
  mila: { name: "MILA Voice", desc: "Gemini Live voice agent, mobile sessions & releases", icon: "mic", color: "violet",
    fields: [{ key: "baseUrl", label: "MILA backend URL" }, { key: "adminToken", label: "Admin Token", secret: true }] },
};

const ok = (detail) => ({ ok: true, detail });
const fail = (detail) => ({ ok: false, detail });

async function timedFetch(url, opts = {}, ms = 9000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  finally { clearTimeout(t); }
}

export async function testConnection(provider, cfg = {}) {
  try {
    switch (provider) {
      case "openai": {
        const base = (cfg.baseUrl || config.openai.baseUrl).replace(/\/$/, "");
        const key = cfg.apiKey || config.openai.key;
        if (!key) return fail("Missing API key");
        const r = await timedFetch(base + "/models", { headers: { Authorization: "Bearer " + key } });
        return r.ok ? ok("Reachable · /models returned 200") : fail("HTTP " + r.status);
      }
      case "anthropic": {
        const key = cfg.apiKey || config.anthropic.key;
        if (!key) return fail("Missing API key");
        const r = await timedFetch(config.anthropic.baseUrl + "/models", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
        return r.ok ? ok("Reachable · /models returned 200") : fail("HTTP " + r.status);
      }
      case "github": {
        const token = cfg.token || config.github;
        if (!token) return fail("Missing token");
        const r = await timedFetch("https://api.github.com/user", { headers: { Authorization: "Bearer " + token, "User-Agent": "agentic-os", Accept: "application/vnd.github+json" } });
        if (!r.ok) return fail("HTTP " + r.status);
        const j = await r.json();
        return ok("Authenticated as @" + j.login);
      }
      case "notion": {
        const token = cfg.token || config.notion;
        if (!token) return fail("Missing token");
        const r = await timedFetch("https://api.notion.com/v1/users/me", { headers: { Authorization: "Bearer " + token, "Notion-Version": "2022-06-28" } });
        if (!r.ok) return fail("HTTP " + r.status);
        const j = await r.json();
        return ok("Connected · " + (j.name || j.bot?.owner?.type || "integration"));
      }
      case "slack": {
        const url = cfg.webhookUrl || config.slack;
        if (!url) return fail("Missing webhook URL");
        if (!/hooks\.slack\.com/.test(url)) return fail("Not a Slack webhook URL");
        return ok("Webhook stored — use 'Send test' to post a message");
      }
      case "postgres": {
        const cs = cfg.connectionString;
        if (!cs) return fail("Missing connection string");
        if (!/^postgres(ql)?:\/\//.test(cs)) return fail("Invalid connection string");
        return ok("Stored (add the 'pg' driver for a live connection check)");
      }
      case "mila": {
        const status = await milaStatus(cfg);
        const voice = status.voiceConfigured ? "voice ready" : "voice key missing";
        return ok(`MILA reachable · ${voice}`);
      }
      default: return fail("Unknown provider");
    }
  } catch (e) {
    return fail(e.name === "AbortError" ? "Timed out" : e.message);
  }
}

export async function slackSend(cfg = {}, text) {
  const url = cfg.webhookUrl || config.slack;
  if (!url) throw new Error("No Slack webhook URL configured");
  const r = await timedFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return true;
}
