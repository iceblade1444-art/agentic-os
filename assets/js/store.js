// Tiny reactive store with localStorage persistence.
import { getLocale } from "./i18n.js";

const BASE_KEY = "agentic-os:v1";
let storageKey = BASE_KEY;

const uid = (p = "id") => p + "_" + Math.random().toString(36).slice(2, 9);
const now = Date.now();
const ago = (min) => now - min * 60000;

const AGENT_COLORS = {
  violet: "linear-gradient(135deg,#8b5cf6,#6d28d9)",
  blue: "linear-gradient(135deg,#3b82f6,#2563eb)",
  green: "linear-gradient(135deg,#22c55e,#16a34a)",
  amber: "linear-gradient(135deg,#f59e0b,#d97706)",
  pink: "linear-gradient(135deg,#ec4899,#db2777)",
  cyan: "linear-gradient(135deg,#06b6d4,#0891b2)",
};

function seed() {
  const agents = [
    { id: uid("agt"), name: "Research Agent", type: "Conversational", model: "GPT-4o", status: "active", tasks: 128, successRate: 98.9, lastRun: ago(2), cpu: 24, mem: 512, color: "violet", icon: "search", tags: ["research", "ai", "trending"], description: "Researches and analyzes any topic with web search.", instructions: "You are a helpful research assistant.", tools: ["search_web", "analyze_data", "summarize"], createdAt: "May 12, 2024" },
    { id: uid("agt"), name: "Code Reviewer", type: "Workflow", model: "Claude Sonnet 5", status: "running", tasks: 84, successRate: 97.1, lastRun: ago(4), cpu: 31, mem: 640, color: "blue", icon: "code", tags: ["code", "review"], description: "Reviews pull requests for bugs and style.", instructions: "Review code for correctness and clarity.", tools: ["read_repo", "comment_pr"], createdAt: "Apr 30, 2024" },
    { id: uid("agt"), name: "Data Analyst", type: "Workflow", model: "GPT-4o", status: "active", tasks: 64, successRate: 99.2, lastRun: ago(10), cpu: 32, mem: 768, color: "green", icon: "database", tags: ["data", "analytics"], description: "Analyzes and visualizes datasets.", instructions: "Analyze datasets and produce insights.", tools: ["run_sql", "make_chart"], createdAt: "May 2, 2024" },
    { id: uid("agt"), name: "Content Writer", type: "Conversational", model: "Claude Sonnet 5", status: "error", tasks: 52, successRate: 85.3, lastRun: ago(18), cpu: 12, mem: 384, color: "amber", icon: "edit", tags: ["content", "writing"], description: "Generates marketing and blog content.", instructions: "Write clear, engaging content.", tools: ["draft_doc", "seo_check"], createdAt: "Apr 18, 2024" },
    { id: uid("agt"), name: "Email Assistant", type: "Tool-based", model: "GPT-4o mini", status: "active", tasks: 210, successRate: 96.7, lastRun: ago(60), cpu: 8, mem: 256, color: "pink", icon: "mail", tags: ["email", "ops"], description: "Triages and drafts email replies.", instructions: "Triage and draft email responses.", tools: ["read_inbox", "send_email"], createdAt: "Mar 22, 2024" },
    { id: uid("agt"), name: "Support Agent", type: "Conversational", model: "Claude Haiku 4.5", status: "active", tasks: 221, successRate: 96.4, lastRun: ago(8), cpu: 15, mem: 300, color: "cyan", icon: "chat", tags: ["support"], description: "Handles customer support tickets.", instructions: "Resolve customer questions politely.", tools: ["lookup_order", "escalate"], createdAt: "Feb 15, 2024" },
  ];
  const activity = [
    { id: uid(), agent: "Research Agent", icon: "search", color: "violet", text: "Completed task", state: "success", at: ago(2) },
    { id: uid(), agent: "Code Reviewer", icon: "code", color: "blue", text: "Running", state: "running", at: ago(4) },
    { id: uid(), agent: "Data Analyst", icon: "database", color: "green", text: "Completed task", state: "success", at: ago(10) },
    { id: uid(), agent: "Content Writer", icon: "edit", color: "amber", text: "Failed", state: "error", at: ago(18) },
    { id: uid(), agent: "Email Assistant", icon: "mail", color: "pink", text: "Processed 12 emails", state: "success", at: ago(32) },
  ];
  const tasks = [
    { id: uid("tsk"), title: "Market Research Report", agent: "Research Agent", status: "completed", progress: 100, due: "May 20" },
    { id: uid("tsk"), title: "Analyze User Feedback", agent: "Data Analyst", status: "completed", progress: 100, due: "May 18" },
    { id: uid("tsk"), title: "Write Blog Post", agent: "Content Writer", status: "in_progress", progress: 75, due: "May 22" },
    { id: uid("tsk"), title: "Competitor Analysis", agent: "Research Agent", status: "queued", progress: 0, due: "May 24" },
    { id: uid("tsk"), title: "Data Visualization", agent: "Data Analyst", status: "queued", progress: 0, due: "May 25" },
  ];
  const workflow = {
    nodes: [
      { id: "n1", type: "trigger", title: "Trigger", sub: "On schedule · 9:00 AM", x: 40, y: 60 },
      { id: "n2", type: "llm", title: "Research", sub: "LLM · GPT-4o", x: 300, y: 60 },
      { id: "n3", type: "tool", title: "Analyze", sub: "Tool · Analyze data", x: 560, y: 60 },
      { id: "n4", type: "condition", title: "Success?", sub: "Condition", x: 560, y: 220 },
      { id: "n5", type: "tool", title: "Notify", sub: "Tool · Send email", x: 820, y: 160 },
      { id: "n6", type: "end", title: "End", sub: "Workflow end", x: 820, y: 300 },
    ],
    edges: [
      { from: "n1", to: "n2" }, { from: "n2", to: "n3" }, { from: "n3", to: "n4" },
      { from: "n4", to: "n5" }, { from: "n4", to: "n6" },
    ],
  };
  const integrations = [
    { id: uid(), name: "OpenAI", desc: "GPT-4o, GPT-4o mini, embeddings", icon: "sparkles", color: "green", connected: true },
    { id: uid(), name: "Anthropic", desc: "Claude Opus, Sonnet, Haiku", icon: "brain", color: "amber", connected: true },
    { id: uid(), name: "Slack", desc: "Send notifications & alerts", icon: "chat", color: "pink", connected: true },
    { id: uid(), name: "GitHub", desc: "Repos, issues, pull requests", icon: "code", color: "violet", connected: false },
    { id: uid(), name: "Postgres", desc: "SQL database connector", icon: "database", color: "blue", connected: true },
    { id: uid(), name: "Notion", desc: "Docs & knowledge base", icon: "file", color: "cyan", connected: false },
  ];
  const mcpServers = [
    { id: uid(), name: "filesystem", cmd: "npx -y @modelcontextprotocol/server-filesystem", status: "active", tools: 8 },
    { id: uid(), name: "github", cmd: "npx -y @modelcontextprotocol/server-github", status: "active", tools: 14 },
    { id: uid(), name: "chrome-devtools", cmd: "npx -y chrome-devtools-mcp@latest", status: "idle", tools: 21 },
    { id: uid(), name: "postgres", cmd: "npx -y @modelcontextprotocol/server-postgres", status: "error", tools: 6 },
  ];
  const chat = {
    sessions: [
      { id: uid("ses"), title: "Trends in AI agents", agentId: agents[0].id, messages: [
        { role: "user", content: "Can you research the latest trends in AI agents?" },
        { role: "assistant", content: "I'll research the latest trends in AI agents and provide you with a comprehensive overview.\n\n**Key trends right now:**\n1. Multi-agent orchestration and handoffs\n2. Tool use via MCP (Model Context Protocol)\n3. Long-running, stateful agents with memory\n4. Guardrails and evaluations becoming first-class\n\nWant me to dive deeper into any of these?" },
      ] },
    ],
    activeSession: null,
  };
  chat.activeSession = chat.sessions[0].id;

  return {
    profile: { name: "Creator", email: "", role: "Creator", avatar: "" },
    settings: {
      theme: "dark",
      llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
      compact: false,
    },
    stats: { activeAgents: 24, tasksRunning: 7, successRate: 98.6, tokensUsed: "2.4M" },
    health: [
      { name: "API", value: 100 }, { name: "Vector DB", value: 100 },
      { name: "Database", value: 99.9 }, { name: "Queue", value: 100 },
    ],
    resources: [
      { name: "CPU Usage", value: 24 }, { name: "Memory Usage", value: 62 },
      { name: "Storage Usage", value: 41 }, { name: "Network I/O", value: 18 },
    ],
    agents, activity, tasks, workflow, integrations, mcpServers, chat,
  };
}

function load(key = storageKey) {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  const data = seed();
  try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) {}
  return data;
}

const listeners = new Set();
export const store = {
  state: load(),
  colors: AGENT_COLORS,
  uid,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit() { listeners.forEach((fn) => fn(this.state)); },
  setScope(userId = "local") {
    const scope = String(userId || "local").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "local";
    const nextKey = scope === "local" ? BASE_KEY : `${BASE_KEY}:${scope}`;
    if (nextKey === storageKey) return;
    try {
      if (!localStorage.getItem(nextKey) && scope === "creator") {
        const legacy = localStorage.getItem(BASE_KEY);
        if (legacy) localStorage.setItem(nextKey, legacy);
      }
    } catch { /* storage can be unavailable in private mode */ }
    storageKey = nextKey;
    this.state = load(nextKey);
    this.emit();
  },
  persist() { try { localStorage.setItem(storageKey, JSON.stringify(this.state)); } catch (e) {} },
  set(mutator) { mutator(this.state); this.persist(); this.emit(); },
  reset() { this.state = seed(); this.persist(); this.emit(); },
};

// utilities
export function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  const formatter = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto", style: "narrow" });
  if (s < 60) return formatter.format(-s, "second");
  const m = Math.floor(s / 60); if (m < 60) return formatter.format(-m, "minute");
  const h = Math.floor(m / 60); if (h < 24) return formatter.format(-h, "hour");
  return formatter.format(-Math.floor(h / 24), "day");
}
