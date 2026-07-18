// Agentic OS server — serves the SPA and the /api backend (LLM proxy, MCP, integrations).
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import llm from "./routes/llm.js";
import mcp from "./routes/mcp.js";
import integrations from "./routes/integrations.js";
import missions from "./routes/missions.js";
import knowledge from "./routes/knowledge.js";
import kanban from "./routes/kanban.js";
import claudeCode from "./routes/claude-code.js";
import { requireAuth, loginHandler, logoutHandler, meHandler, rateLimit, authEnabled } from "./lib/auth.js";
import { hermesDashboardStatus, mountHermesProxy } from "./lib/hermes-proxy.js";
import * as mcpManager from "./mcp/manager.js";
import { db } from "./store.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const app = express();
const server = createServer(app);
app.disable("x-powered-by");
app.set("trust proxy", 1); // behind nginx — correct req.ip / req.secure

// Security headers + CSP
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://api.openai.com https://api.anthropic.com wss://generativelanguage.googleapis.com",
  "script-src 'self'",
  "frame-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");
app.use((req, res, next) => {
  if (req.path === "/hermes" || req.path.startsWith("/hermes/")) return next();
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", CSP);
  next();
});

// Hermes serves its official dashboard here, including PTY WebSockets. Mount
// before body parsers so config forms, uploads and streaming bodies stay intact.
mountHermesProxy(app, server);

// CORS: same-origin only unless ALLOW_ORIGIN is set explicitly
if (config.allowOrigin) app.use(cors({ origin: config.allowOrigin.split(",").map((s) => s.trim()), credentials: true }));

app.use(express.json({ limit: "1mb" }));
app.use("/api", rateLimit({ windowMs: 60000, max: 600 }));

// ---- Public API ----
app.get("/api/health", (req, res) =>
  res.json({
    ok: true, name: "agentic-os", version: "1.0.0",
    features: { llm: true, mcp: true, integrations: true },
    providers: { openai: !!config.openai.key, anthropic: !!config.anthropic.key },
    auth: authEnabled(),
  }));
app.post("/api/auth/login", rateLimit({ windowMs: 60000, max: 10 }), loginHandler);
app.post("/api/auth/logout", logoutHandler);
app.get("/api/auth/me", meHandler);

// ---- Protected API (everything below requires auth when AUTH_TOKEN is set) ----
app.use("/api", requireAuth);
app.use("/api/llm", llm);
app.use("/api/mcp", mcp);
app.use("/api/integrations", integrations);
app.use("/api/missions", missions);
app.use("/api/knowledge", knowledge);
app.use("/api/kanban", kanban);
app.use("/api/claude-code", claudeCode);
app.get("/api/hermes/control/status", async (req, res) => res.json(await hermesDashboardStatus()));
app.use("/api", (req, res) => res.status(404).json({ error: "not found" }));

// ---- Static frontend (only assets + index.html; never expose server/, .env, node_modules) ----
app.use("/assets", express.static(path.join(ROOT, "assets"), { maxAge: 0 }));
app.get(["/", "/index.html"], (req, res) => res.sendFile(path.join(ROOT, "index.html")));
// SPA fallback for any non-API GET
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api")) return res.sendFile(path.join(ROOT, "index.html"));
  next();
});

app.use((err, req, res, next) => { console.error("[error]", err); res.status(500).json({ error: err.message }); });

server.listen(config.port, async () => {
  console.log(`\n  ▲ Agentic OS running → http://localhost:${config.port}`);
  console.log(`    LLM proxy   : ${config.openai.key ? "openai ✓" : "openai —"}  ${config.anthropic.key ? "anthropic ✓" : "anthropic —"}`);
  console.log(`    Data store  : ${path.resolve(config.dataDir)}/db.json`);
  if (authEnabled()) console.log(`    Auth        : enabled ✓${config.allowCustomMcp ? "   Custom MCP: allowed" : ""}`);
  else console.log(`    \x1b[33mAuth        : DISABLED — set AUTH_TOKEN before exposing this beyond localhost\x1b[0m`);
  console.log("");
  if (config.autoConnectObsidian) {
    const obsidian = db.mcp.get("mcp_obsidian");
    if (!obsidian) {
      console.warn("    Obsidian    : MCP server is not configured");
      return;
    }
    try {
      const connected = await mcpManager.connect(obsidian);
      db.mcp.update(obsidian.id, { status: "active", tools: connected.tools });
      console.log(`    Obsidian    : active ✓ (${connected.tools.length} MCP tools)`);
    } catch (error) {
      db.mcp.update(obsidian.id, { status: "error" });
      console.error(`    Obsidian    : failed — ${error.message}`);
    }
  }
});

async function bye() { await mcpManager.shutdownAll(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); }
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
