// Frontend API client + backend detection. When the Node backend is present,
// MCP / Integrations / Chat use real endpoints; otherwise the app falls back to
// the local localStorage mock so the static build still works.
const state = { on: false, health: null, authRequired: false, authed: true, user: null };

async function j(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

export const api = {
  get on() { return state.on; },
  get health() { return state.health; },
  serverHasLLM() { const p = state.health?.providers || {}; return state.on && (p.openai || p.anthropic); },
  async detect() {
    try {
      const res = await fetch("/api/health");
      if (res.ok) {
        state.health = await res.json();
        state.on = true;
        state.authRequired = !!state.health.auth;
        try {
          const me = await (await fetch("/api/auth/me")).json();
          state.authed = !!me.authed;
          state.user = me.user || null;
        } catch {
          state.authed = !state.authRequired;
          state.user = null;
        }
      }
    } catch { state.on = false; }
    return state.on;
  },
  get needsAuth() { return state.on && state.authRequired && !state.authed; },
  auth: {
    get user() { return state.user; },
    login: async (password) => {
      const result = await j("/api/auth/login", { method: "POST", body: { password } });
      state.authed = true;
      state.user = result.user || null;
      return result;
    },
    logout: () => j("/api/auth/logout", { method: "POST" }),
    me: () => j("/api/auth/me"),
  },
  mcp: {
    list: () => j("/api/mcp/servers"),
    connect: (id) => j(`/api/mcp/servers/${id}/connect`, { method: "POST" }),
    disconnect: (id) => j(`/api/mcp/servers/${id}/disconnect`, { method: "POST" }),
    add: (body) => j("/api/mcp/servers", { method: "POST", body }),
    remove: (id) => j(`/api/mcp/servers/${id}`, { method: "DELETE" }),
    call: (id, tool, args) => j(`/api/mcp/servers/${id}/call`, { method: "POST", body: { tool, args } }),
  },
  integrations: {
    list: () => j("/api/integrations"),
    connect: (provider, config) => j(`/api/integrations/${provider}/connect`, { method: "POST", body: { config } }),
    disconnect: (provider) => j(`/api/integrations/${provider}/disconnect`, { method: "POST" }),
    test: (provider) => j(`/api/integrations/${provider}/test`, { method: "POST" }),
    slackSend: (text) => j("/api/integrations/slack/send", { method: "POST", body: { text } }),
    milaStatus: () => j("/api/integrations/mila/status"),
    milaVoiceToken: () => j("/api/integrations/mila/voice-token", { method: "POST" }),
    milaConnectionCode: (label) => j("/api/integrations/mila/connection-code", { method: "POST", body: { label } }),
    milaSubscription: (body) => j("/api/integrations/mila/subscription", { method: "POST", body }),
    milaAppUpdate: (body) => j("/api/integrations/mila/app-update", { method: "POST", body }),
  },
  missions: {
    list: () => j("/api/missions"),
    create: (body) => j("/api/missions", { method: "POST", body }),
    get: (id) => j("/api/missions/" + id),
    async run(id, onEvent) {
      const res = await fetch(`/api/missions/${id}/run`, { method: "POST" });
      if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const p = t.slice(5).trim();
          if (p === "[DONE]") return;
          try { onEvent(JSON.parse(p)); } catch { /* keep-alive */ }
        }
      }
    },
  },
  hermes: { status: () => j("/api/hermes/control/status") },
  llm: { status: () => j("/api/llm/status") },
};
