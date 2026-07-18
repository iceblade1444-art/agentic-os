// Frontend API client + backend detection. When the Node backend is present,
// MCP / Integrations / Chat use real endpoints; otherwise the app falls back to
// the local localStorage mock so the static build still works.
const state = { on: false, health: null, authRequired: false, registration: false, authed: true, user: null, capabilities: {} };

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
  serverHasLLM() { const p = state.health?.providers || {}; return state.on && Object.values(p).some(Boolean); },
  async detect() {
    try {
      const res = await fetch("/api/health");
      if (res.ok) {
        state.health = await res.json();
        state.on = true;
        state.authRequired = !!state.health.auth;
        state.registration = !!state.health.registration;
        try {
          const me = await (await fetch("/api/auth/me")).json();
          state.authed = !!me.authed;
          state.user = me.user || null;
          state.registration = !!me.registration;
          state.capabilities = me.capabilities || {};
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
    get registration() { return state.registration; },
    get capabilities() { return state.capabilities; },
    get canAdmin() { return !!state.capabilities.canAdmin; },
    get canWrite() { return state.capabilities.canWrite !== false; },
    login: async (body) => {
      const credentials = typeof body === "string" ? { password: body } : body;
      const result = await j("/api/auth/login", { method: "POST", body: credentials });
      state.authed = true;
      state.user = result.user || null;
      state.capabilities = result.capabilities || {};
      return result;
    },
    register: async (body) => {
      const result = await j("/api/auth/register", { method: "POST", body });
      state.authed = true;
      state.user = result.user || null;
      state.capabilities = result.capabilities || {};
      return result;
    },
    logout: () => j("/api/auth/logout", { method: "POST" }),
    me: () => j("/api/auth/me"),
    users: () => j("/api/auth/users"),
    updateUser: (id, body) => j(`/api/auth/users/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  },
  mcp: {
    list: () => j("/api/mcp/servers"),
    connect: (id) => j(`/api/mcp/servers/${id}/connect`, { method: "POST" }),
    disconnect: (id) => j(`/api/mcp/servers/${id}/disconnect`, { method: "POST" }),
    add: (body) => j("/api/mcp/servers", { method: "POST", body }),
    remove: (id) => j(`/api/mcp/servers/${id}`, { method: "DELETE" }),
    call: (id, tool, args) => j(`/api/mcp/servers/${id}/call`, { method: "POST", body: { tool, args } }),
  },
  knowledge: {
    status: () => j("/api/knowledge/status"),
    list: (query = "") => j(`/api/knowledge/notes${query ? `?q=${encodeURIComponent(query)}` : ""}`),
    read: (path) => j(`/api/knowledge/notes/read?path=${encodeURIComponent(path)}`),
    search: (query, limit = 20) => j(`/api/knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}`),
    usage: (limit = 50) => j(`/api/knowledge/usage?limit=${limit}`),
    create: (body) => j("/api/knowledge/notes", { method: "POST", body }),
    append: (body) => j("/api/knowledge/notes/append", { method: "POST", body }),
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
  mila: {
    action: (name, args = {}) => j("/api/mila/actions", { method: "POST", body: { name, args } }),
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
  kanban: {
    board: () => j("/api/kanban/board"),
    profiles: () => j("/api/kanban/profiles"),
    orchestration: () => j("/api/kanban/orchestration"),
    updateOrchestration: (body) => j("/api/kanban/orchestration", { method: "PUT", body }),
    createTask: (body) => j("/api/kanban/tasks", { method: "POST", body }),
    task: (id) => j(`/api/kanban/tasks/${encodeURIComponent(id)}`),
    taskLog: (id) => j(`/api/kanban/tasks/${encodeURIComponent(id)}/log`),
    updateTask: (id, body) => j(`/api/kanban/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body }),
    comment: (id, body) => j(`/api/kanban/tasks/${encodeURIComponent(id)}/comments`, { method: "POST", body }),
    decompose: (id) => j(`/api/kanban/tasks/${encodeURIComponent(id)}/decompose`, { method: "POST" }),
    dispatch: () => j("/api/kanban/dispatch", { method: "POST" }),
    async uploadAttachment(id, file) {
      const res = await fetch(`/api/kanban/tasks/${encodeURIComponent(id)}/attachments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
          "X-File-Type": file.type || "application/octet-stream",
        },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      return data;
    },
    async downloadAttachment(id) {
      const res = await fetch(`/api/kanban/attachments/${encodeURIComponent(id)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "HTTP " + res.status);
      }
      return { blob: await res.blob(), disposition: res.headers.get("Content-Disposition") || "" };
    },
    deleteAttachment: (id) => j(`/api/kanban/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
  claude: {
    status: (probe = false) => j(`/api/claude-code/status${probe ? "?probe=true" : ""}`),
    projects: () => j("/api/claude-code/projects"),
    projectStatus: (workdir) => j(`/api/claude-code/projects/status?workdir=${encodeURIComponent(workdir)}`),
    importProject: (body) => j("/api/claude-code/projects/import", { method: "POST", body }),
    syncProject: (workdir) => j("/api/claude-code/projects/sync", { method: "POST", body: { workdir } }),
    sessions: () => j("/api/claude-code/sessions"),
    session: (id) => j(`/api/claude-code/sessions/${encodeURIComponent(id)}`),
    createSession: (body) => j("/api/claude-code/sessions", { method: "POST", body }),
    removeSession: (id) => j(`/api/claude-code/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
    message: (id, body) => j(`/api/claude-code/sessions/${encodeURIComponent(id)}/messages`, { method: "POST", body }),
    delegate: (id, body) => j(`/api/claude-code/sessions/${encodeURIComponent(id)}/delegate`, { method: "POST", body }),
    files: (workdir, filePath = "") => j(`/api/claude-code/files?workdir=${encodeURIComponent(workdir)}&path=${encodeURIComponent(filePath)}`),
    file: (workdir, filePath) => j(`/api/claude-code/file?workdir=${encodeURIComponent(workdir)}&path=${encodeURIComponent(filePath)}`),
  },
  hermes: { status: () => j("/api/hermes/control/status") },
  llm: { status: () => j("/api/llm/status") },
};
