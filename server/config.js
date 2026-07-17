// Central config. Loads .env if present (Node >=20.6 has process.loadEnvFile).
try { process.loadEnvFile(); } catch { /* no .env file — use process env / defaults */ }

const env = process.env;
const strip = (u, d) => (u || d).replace(/\/$/, "");

export const config = {
  port: Number(env.PORT) || 8787,
  dataDir: env.DATA_DIR || "./data",
  allowOrigin: env.ALLOW_ORIGIN || "",
  openai: { key: env.OPENAI_API_KEY || "", baseUrl: strip(env.OPENAI_BASE_URL, "https://api.openai.com/v1") },
  anthropic: { key: env.ANTHROPIC_API_KEY || "", baseUrl: strip(env.ANTHROPIC_BASE_URL, "https://api.anthropic.com/v1") },
  defaultModel: env.DEFAULT_MODEL || "gpt-4o-mini",
  github: env.GITHUB_TOKEN || "",
  notion: env.NOTION_TOKEN || "",
  slack: env.SLACK_WEBHOOK_URL || "",
  obsidianVault: env.OBSIDIAN_VAULT || "./vault",
  autoConnectObsidian: env.AUTO_CONNECT_OBSIDIAN !== "false",
  agentosRuntimeUrl: strip(env.AGENTOS_RUNTIME_URL, "http://agentos-runtime:8765"),
  hermesDashboardUrl: strip(env.HERMES_DASHBOARD_URL, "http://host.docker.internal:9119"),
  hermesDashboardSocket: env.HERMES_DASHBOARD_SOCKET || "",
  hermesKanbanBoard: env.HERMES_KANBAN_BOARD || "agentic-os",
  creator: {
    id: "creator",
    name: env.CREATOR_NAME || "Creator",
    email: env.CREATOR_EMAIL || "",
    role: "Creator",
    avatar: "",
  },

  // ---- security ----
  authToken: env.AUTH_TOKEN || "",                       // empty = auth disabled (dev)
  sessionSecret: env.SESSION_SECRET || env.AUTH_TOKEN || "agentic-os-dev-secret",
  secureCookie: env.SECURE_COOKIE === "true",            // set true behind HTTPS
  agenticToken: env.AGENTIC_OS_TOKEN || env.AUTH_TOKEN || "",
  allowCustomMcp: env.ALLOW_CUSTOM_MCP === "true",       // gate arbitrary command spawning
  mcpAllowedCommands: (env.MCP_ALLOWED_COMMANDS || "npx,node,uvx,uv,python,python3,deno,bun,docker")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
};
