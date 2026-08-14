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
import member, { configureMemberReadAdapter, configureMemberWriteAdapter } from "./routes/member.js";
import personal from "./routes/personal.js";
import telemetry from "./routes/telemetry.js";
import skills from "./routes/skills.js";
import routines from "./routes/routines.js";
import governance from "./routes/governance.js";
import memory from "./routes/memory.js";
import studio from "./routes/studio.js";
import erp from "./routes/erp.js";
import {
  authEnabled, configureAuthReadAdapter, listSessionsHandler, listUsersHandler, loginHandler, logoutHandler, meHandler, rateLimit,
  mfaVerifyHandler, mobileLoginHandler, mobilePairExchangeHandler, mobileRegisterHandler, registerHandler, requireAuth, requireRoles,
  requireWriteAccess, revokeOtherSessionsHandler, revokeSessionHandler, updateUserHandler,
} from "./lib/auth.js";
import { configureAccountWorkspaceStore, deleteUserHandler } from "./lib/account-lifecycle.js";
import {
  forgotPasswordHandler, recoveryStatus, resendVerificationHandler, resetPasswordHandler, verifyEmailHandler,
} from "./lib/account-recovery.js";
import {
  changeOwnPasswordHandler, deleteOwnAccountHandler, exportOwnDataHandler,
} from "./lib/account-self-service.js";
import {
  mfaDisableHandler, mfaEnableHandler, mfaRecoveryHandler, mfaSetupHandler, mfaStatusHandler,
} from "./lib/mfa-self-service.js";
import { hermesDashboardStatus, mountHermesProxy } from "./lib/hermes-proxy.js";
import { mountLiveKitProxy } from "./lib/livekit-proxy.js";
import { PostgresShadowOutbox } from "./lib/postgres-shadow-outbox.js";
import { PostgresMemberReadAdapter } from "./lib/postgres-member-read.js";
import { PostgresMemberWriteAdapter } from "./lib/postgres-member-write.js";
import { PostgresAuthWriteAdapter } from "./lib/postgres-auth-write.js";
import { PostgresAuthReadAdapter } from "./lib/postgres-auth-read.js";
import { PostgresShadowSync } from "./lib/postgres-shadow-sync.js";
import { configureAuthWriteAdapter } from "./lib/auth-persistence.js";
import { onRuntimeFileMutation } from "./lib/runtime-files.js";
import * as mcpManager from "./mcp/manager.js";
import { db } from "./store.js";
import { memberWorkspaces } from "./lib/member-workspace.js";
import { sessions } from "./lib/sessions.js";
import { users } from "./lib/users.js";
import { googleWorkspace } from "./lib/google-workspace.js";
import { pushService } from "./lib/push-service.js";
import { reminders } from "./lib/reminders.js";
import messenger from "./routes/messenger.js";
import { morningBrief } from "./lib/morning-brief.js";
import { telegram } from "./lib/telegram.js";
import { telegramAssistant } from "./lib/telegram-assistant.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const app = express();
const server = createServer(app);
const postgresOutbox = new PostgresShadowOutbox({ dataDir: config.dataDir });
const postgresShadow = new PostgresShadowSync({
  enabled: config.postgres.shadowSyncEnabled,
  dataDir: config.dataDir,
  databaseUrl: config.postgres.databaseUrl,
  intervalMs: config.postgres.shadowSyncIntervalMs,
  debounceMs: config.postgres.shadowSyncDebounceMs,
  outbox: postgresOutbox,
  replayOnly: config.postgres.writeMode === "member-primary"
    && config.postgres.authWriteMode === "primary",
});
const postgresAuthWrites = new PostgresAuthWriteAdapter({
  mode: config.postgres.authWriteMode,
  dataDir: config.dataDir,
  databaseUrl: config.postgres.databaseUrl,
  shadowStatus: () => postgresShadow.status(),
});
const postgresAuthReads = new PostgresAuthReadAdapter({
  mode: config.postgres.authReadMode,
  databaseUrl: config.postgres.databaseUrl,
  shadowStatus: () => postgresShadow.status(),
  userStore: users,
  sessionStore: sessions,
});
const stopPostgresMutationListener = onRuntimeFileMutation((file) => {
  postgresAuthWrites.request(file);
  if (postgresShadow.enabled && postgresOutbox.record(file)) postgresShadow.request();
});
const postgresMemberReads = new PostgresMemberReadAdapter({
  mode: config.postgres.readMode,
  databaseUrl: config.postgres.databaseUrl,
  shadowStatus: () => postgresShadow.status(),
  fallbackStore: memberWorkspaces,
});
const postgresMemberWrites = new PostgresMemberWriteAdapter({
  mode: config.postgres.writeMode,
  databaseUrl: config.postgres.databaseUrl,
  shadowStatus: () => postgresShadow.status(),
  fallbackStore: memberWorkspaces,
});
configureMemberReadAdapter(postgresMemberReads);
configureMemberWriteAdapter(postgresMemberWrites);
configureAccountWorkspaceStore(postgresMemberWrites);
configureAuthReadAdapter(postgresAuthReads);
configureAuthWriteAdapter(postgresAuthWrites);
app.disable("x-powered-by");
app.set("trust proxy", 1); // behind nginx — correct req.ip / req.secure

// Security headers + CSP
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:", // https: — generated media (Higgsfield CDN) renders in Studio
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
    features: { llm: true, mcp: true, integrations: true, operations: true, push: pushService.configured() },
    providers: {
      openai: !!(config.openai.key || db.integrations.byProvider("openai")?.config?.apiKey),
      anthropic: !!(config.anthropic.key || db.integrations.byProvider("anthropic")?.config?.apiKey),
      hermes: !!config.hermesChatSocket && fs.existsSync(config.hermesChatSocket),
    },
    auth: authEnabled(), registration: config.allowRegistration, accountRecovery: recoveryStatus(),
    database: {
      sourceOfTruth: postgresMemberWrites.primary && postgresAuthWrites.primary ? "postgres" : "hybrid",
      jsonRole: postgresMemberWrites.primary && postgresAuthWrites.primary ? "write-ahead-rollback" : "primary-shadow",
      ...postgresShadow.status(),
      reads: postgresMemberReads.status(),
      writes: postgresMemberWrites.status(),
      authWrites: postgresAuthWrites.status(),
      authReads: postgresAuthReads.status(),
    },
  }));
app.post("/api/auth/login", rateLimit({ windowMs: 60000, max: 10 }), loginHandler);
app.post("/api/auth/register", rateLimit({ windowMs: 10 * 60000, max: 5 }), registerHandler);
app.post("/api/auth/mobile/login", rateLimit({ windowMs: 60000, max: 10 }), mobileLoginHandler);
app.post("/api/auth/mobile/register", rateLimit({ windowMs: 10 * 60000, max: 5 }), mobileRegisterHandler);
app.post("/api/auth/mobile/exchange", rateLimit({ windowMs: 60000, max: 10 }), mobilePairExchangeHandler);
app.post("/api/auth/mfa/verify", rateLimit({ windowMs: 5 * 60000, max: 10 }), mfaVerifyHandler);
app.post("/api/auth/logout", logoutHandler);
app.get("/api/auth/me", meHandler);
app.post("/api/auth/password/forgot", rateLimit({ windowMs: 10 * 60000, max: 5 }), forgotPasswordHandler);
app.post("/api/auth/password/reset", rateLimit({ windowMs: 10 * 60000, max: 5 }), resetPasswordHandler);
app.post("/api/auth/email/verify", rateLimit({ windowMs: 10 * 60000, max: 10 }), verifyEmailHandler);
app.post("/api/auth/email/resend", rateLimit({ windowMs: 10 * 60000, max: 5 }), resendVerificationHandler);
app.get("/api/personal/google/callback", rateLimit({ windowMs: 10 * 60000, max: 30 }), async (req, res, next) => {
  try {
    const result = await googleWorkspace.callback(req.query.code, req.query.state);
    if (result.client !== "mobile") {
      res.redirect("/#/personal");
      return;
    }
    const copy = {
      ru: ["Google Calendar подключён", "Эту страницу можно закрыть и вернуться в MILA. Календарь синхронизирован с вашим аккаунтом Agentic OS."],
      uz: ["Google Calendar ulandi", "Bu sahifani yopib, MILA ilovasiga qaytishingiz mumkin. Kalendar Agentic OS akkauntingiz bilan sinxronlandi."],
      en: ["Google Calendar connected", "You can close this page and return to MILA. Your calendar is now synchronized with your Agentic OS account."],
    }[result.locale] || ["Google Calendar connected", "You can close this page and return to MILA. Your calendar is now synchronized with your Agentic OS account."];
    res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Google Calendar connected</title><style>
body{margin:0;background:#090d18;color:#f8fafc;font-family:system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}
main{max-width:420px;padding:32px;text-align:center}b{display:block;font-size:24px;margin:16px}p{color:#a7b0c4;line-height:1.5}
</style></head><body><main><div aria-hidden="true">✓</div><b>${copy[0]}</b>
<p>${copy[1]}</p>
</main></body></html>`);
  } catch (error) { next(error); }
});

// ---- Protected API (everything below requires auth when AUTH_TOKEN is set) ----
// internal-secret bypass: service-to-service LLM calls (speech post-correction)
app.use("/api/llm", (req, res, next) => {
  const secret = process.env.INTERNAL_SECRET;
  if (secret && req.get("x-internal-secret") === secret) return llm(req, res, next);
  return next();
});
app.use("/api", requireAuth);
// Every signed-in role may inspect and revoke only its own sessions.
app.get("/api/auth/sessions", listSessionsHandler);
app.delete("/api/auth/sessions/:id", revokeSessionHandler);
app.post("/api/auth/sessions/revoke-others", revokeOtherSessionsHandler);
app.get("/api/auth/mfa", mfaStatusHandler);
app.post("/api/auth/mfa/setup", rateLimit({ windowMs: 10 * 60000, max: 5 }), mfaSetupHandler);
app.post("/api/auth/mfa/enable", rateLimit({ windowMs: 10 * 60000, max: 5 }), mfaEnableHandler);
app.post("/api/auth/mfa/recovery", rateLimit({ windowMs: 10 * 60000, max: 5 }), mfaRecoveryHandler);
app.delete("/api/auth/mfa", rateLimit({ windowMs: 10 * 60000, max: 5 }), mfaDisableHandler);
app.post("/api/auth/account/password", rateLimit({ windowMs: 10 * 60000, max: 5 }), changeOwnPasswordHandler);
app.get("/api/auth/account/export", exportOwnDataHandler);
app.delete("/api/auth/account", rateLimit({ windowMs: 10 * 60000, max: 5 }), deleteOwnAccountHandler);
app.use("/api", requireWriteAccess);
const requireOperator = requireRoles("Creator", "Admin");
// Design shares the studio surface with operators, nothing else.
const requireStudio = requireRoles("Creator", "Admin", "Design");
app.get("/api/auth/users", requireRoles("Creator", "Admin"), listUsersHandler);
app.patch("/api/auth/users/:id", requireRoles("Creator", "Admin"), updateUserHandler);
app.delete("/api/auth/users/:id", requireRoles("Creator", "Admin"), deleteUserHandler);
app.use("/api/llm", llm);
app.use("/api/onboarding", onboarding);
app.use("/api/member", member);
app.use("/api/messenger", messenger);
app.use("/api/personal", personal);
app.use("/api/telemetry", telemetry);
app.use("/api/memory", memory);
app.use("/api/speech", requireOperator, speech);
app.use("/api/mcp", requireOperator, mcp);
// Mila voice/chat runs for every signed-in role; credential management and every
// other provider stay operator-only via requireAdmin on each route inside.
app.use("/api/integrations", integrations);
app.use("/api/missions", requireOperator, missions);
app.use("/api/knowledge", requireStudio, knowledge);
app.use("/api/kanban", requireOperator, kanban);
app.use("/api/claude-code", requireOperator, claudeCode);
// Same split: read-only ERP voice actions are open, everything else (Kanban,
// Hermes, Obsidian, Claude Code, MCP) is gated inside mila-actions.js.
app.use("/api/mila", milaActions);
app.use("/api/operations", requireOperator, operations);
app.use("/api/pulse", requireOperator, pulse);
app.use("/api/skills", requireOperator, skills);
app.use("/api/routines", requireOperator, routines);
app.use("/api/studio", requireStudio, studio);
// ERP is readable by every signed-in role; the router keeps its write tools operator-only.
app.use("/api/erp", erp);
app.use("/api/governance", requireOperator, governance);
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

// Routes signal an expected refusal by attaching a status to the error — "not a
// member" is 403, "no such message" is 404. Reporting all of them as 500 made a
// validation message indistinguishable from a crashed server, and filled the log
// with stack traces for things that were working exactly as designed.
app.use((err, req, res, next) => {
  const status = Number(err?.status);
  const expected = Number.isInteger(status) && status >= 400 && status < 500;
  if (expected) console.warn(`[api] ${status} ${req.method} ${req.path}: ${err.message}`);
  else console.error("[error]", err);
  res.status(expected ? status : 500).json({ error: err.message });
});

server.listen(config.port, async () => {
  console.log(`\n  ▲ Agentic OS running → http://localhost:${config.port}`);
  console.log(`    LLM proxy   : ${config.openai.key ? "openai ✓" : "openai —"}  ${config.anthropic.key ? "anthropic ✓" : "anthropic —"}`);
  console.log(`    Data store  : ${path.resolve(config.dataDir)}/db.json`);
  if (authEnabled()) console.log(`    Auth        : enabled ✓${config.allowCustomMcp ? "   Custom MCP: allowed" : ""}`);
  else console.log(`    \x1b[33mAuth        : DISABLED — set AUTH_TOKEN before exposing this beyond localhost\x1b[0m`);
  postgresShadow.start();
  postgresAuthReads.start();
  reminders.start();
  morningBrief.start();
  telegram.assistant = telegramAssistant;
  telegram.start();
  console.log(`    PostgreSQL  : ${postgresShadow.enabled ? "shadow sync enabled" : "shadow sync disabled"}`);
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

async function bye() {
  stopPostgresMutationListener();
  await postgresAuthReads.stop();
  await postgresAuthWrites.stop();
  await postgresMemberWrites.stop();
  await postgresMemberReads.stop();
  await postgresShadow.stop();
  await mcpManager.shutdownAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 12000);
}
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
