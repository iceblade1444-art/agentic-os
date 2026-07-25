// Agentic OS server — serves the SPA and the /api backend (LLM proxy, MCP, integrations).
import express from "express";
import cors from "cors";
import fs from "node:fs";
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
import milaActions from "./routes/mila-actions.js";
import operations from "./routes/operations.js";
import pulse from "./routes/pulse.js";
import speech from "./routes/speech.js";
import onboarding from "./routes/onboarding.js";
import member from "./routes/member.js";
import skills from "./routes/skills.js";
import routines from "./routes/routines.js";
import {
  authEnabled, listUsersHandler, loginHandler, logoutHandler, meHandler, rateLimit,
  mobileLoginHandler, mobileRegisterHandler, registerHandler, requireAuth, requireRoles,
  requireWriteAccess, updateUserHandler,
} from "./lib/auth.js";
import { hermesDashboardStatus, mountHermesProxy } from "./lib/hermes-proxy.js";
import { mountLiveKitProxy } from "./lib/livekit-proxy.js";
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
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "connect-src 'self' https://api.openai.com https://api.anthropic.com wss://agent.milanapremium.uz wss://generativelanguage.googleapis.com",
  "script-src 'self'",
  "media-src 'self' blob:",
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
mountLiveKitProxy(app, server);

// CORS: same-origin only unless ALLOW_ORIGIN is set explicitly
if (config.allowOrigin) app.use(cors({ origin: config.allowOrigin.split(",").map((s) => s.trim()), credentials: true }));

app.use(express.json({ limit: "1mb" }));
app.use("/api", rateLimit({ windowMs: 60000, max: 600 }));

// ---- Public API ----
app.get("/api/health", (req, res) =>
  res.json({
    ok: true, name: "agentic-os", version: "1.0.0",
    features: { llm: true, mcp: true, integrations: true, operations: true },
    providers: {
      openai: !!(config.openai.key || db.integrations.byProvider("openai")?.config?.apiKey),
      anthropic: !!(config.anthropic.key || db.integrations.byProvider("anthropic")?.config?.apiKey),
      hermes: !!config.hermesChatSocket && fs.existsSync(config.hermesChatSocket),
    },
    auth: authEnabled(), registration: config.allowRegistration,
  }));
app.post("/api/auth/login", rateLimit({ windowMs: 60000, max: 10 }), loginHandler);
app.post("/api/auth/register", rateLimit({ windowMs: 10 * 60000, max: 5 }), registerHandler);
app.post("/api/auth/mobile/login", rateLimit({ windowMs: 60000, max: 10 }), mobileLoginHandler);
app.post("/api/auth/mobile/register", rateLimit({ windowMs: 10 * 60000, max: 5 }), mobileRegisterHandler);
app.post("/api/auth/logout", logoutHandler);
app.get("/api/auth/me", meHandler);

// ---- Protected API (everything below requires auth when AUTH_TOKEN is set) ----
app.use("/api", requireAuth);
app.use("/api", requireWriteAccess);
const requireOperator = requireRoles("Creator", "Admin");
app.get("/api/auth/users", requireRoles("Creator", "Admin"), listUsersHandler);
app.patch("/api/auth/users/:id", requireRoles("Creator", "Admin"), updateUserHandler);
app.use("/api/llm", llm);
app.use("/api/onboarding", onboarding);
app.use("/api/member", member);
app.use("/api/speech", requireOperator, speech);
app.use("/api/mcp", requireOperator, mcp);
app.use("/api/integrations", requireOperator, integrations);
app.use("/api/missions", requireOperator, missions);
app.use("/api/knowledge", requireOperator, knowledge);
app.use("/api/kanban", requireOperator, kanban);
app.use("/api/claude-code", requireOperator, claudeCode);
app.use("/api/mila", requireOperator, milaActions);
app.use("/api/operations", requireOperator, operations);
app.use("/api/pulse", requireOperator, pulse);
app.use("/api/skills", requireOperator, skills);
app.use("/api/routines", requireOperator, routines);
app.get("/api/hermes/control/status", requireOperator, async (req, res) => res.json(await hermesDashboardStatus()));
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
