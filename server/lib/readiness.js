import { config } from "../config.js";
import { db } from "../store.js";
import * as mcp from "../mcp/manager.js";
import { claudeCode } from "./claude-code.js";
import { mergeHermesFleetHealth, readHermesFleetHealth } from "./hermes-fleet-health.js";
import { hermesCronRequest, hermesKanbanRequest, kanbanPath } from "./hermes-kanban.js";
import { hermesDashboardStatus } from "./hermes-proxy.js";
import { knowledge } from "./knowledge.js";
import { milaStatus } from "./mila.js";
import { onboarding } from "./onboarding.js";
import { readOperationsState } from "./operations.js";

const checked = (id, label, ok, detail, action = "", href = "") => ({
  id,
  label,
  ok: ok === true,
  detail: String(detail || "").slice(0, 240),
  action,
  href,
});

const countTasks = (board, status = "") => (board?.columns || [])
  .filter((column) => !status || column.name === status)
  .reduce((sum, column) => sum + (Array.isArray(column.tasks) ? column.tasks.length : 0), 0);

function section(id, label, description, checks) {
  const passed = checks.filter((item) => item.ok).length;
  const score = Math.round((passed / Math.max(1, checks.length)) * 100);
  return {
    id,
    label,
    description,
    score,
    status: score >= 80 ? "ready" : score >= 50 ? "attention" : "blocked",
    checks,
  };
}

export function buildFourCReadiness(snapshot) {
  const {
    onboardingState = {},
    vault = {},
    hermes = {},
    claude = {},
    mila = {},
    profiles = {},
    board = {},
    operations = {},
    connectedIntegrations = [],
    liveMcp = [],
    cronJobs = [],
  } = snapshot;
  const goals = onboardingState.workspace?.goals || [];
  const profileCount = Array.isArray(profiles.profiles) ? profiles.profiles.length : 0;
  const healthyProfileCount = Array.isArray(profiles.profiles) ? profiles.profiles.filter((profile) => profile?.health?.ok).length : 0;
  const fleetReady = profileCount >= 5 && healthyProfileCount >= 5 && profiles.fleetHealth?.stale === false;
  const totalTasks = countTasks(board);
  const scheduledTasks = countTasks(board, "scheduled");
  const activeRoutines = (Array.isArray(cronJobs) ? cronJobs : []).filter((job) => job.enabled !== false && job.paused !== true && job.status !== "paused");

  const sections = [
    section("context", "Context", "Shared business knowledge and user preferences", [
      checked("onboarding", "Workspace onboarding", onboardingState.needsOnboarding === false, onboardingState.needsOnboarding === false ? "Profile and workspace context are complete." : "Finish onboarding so every agent receives the same brief.", "Complete onboarding", "#/settings"),
      checked("goals", "Operating goals", goals.length > 0, goals.length ? `${goals.length} active goals are available to agents.` : "No workspace goals are defined.", "Add workspace goals", "#/settings"),
      checked("vault", "Obsidian knowledge vault", vault.ready && vault.writable, vault.ready ? `${vault.notes || 0} notes in a writable vault.` : "The shared vault is unavailable.", "Open Knowledge", "#/knowledge"),
      checked("shared-notes", "Shared agent context notes", (vault.notes || 0) >= 2, (vault.notes || 0) >= 2 ? "Workspace and user notes are synchronized." : "Expected workspace and user context notes are missing.", "Review library", "#/knowledge"),
    ]),
    section("connections", "Connections", "Reliable links between the operating system and its services", [
      checked("hermes-link", "Hermes dashboard", hermes.ready, hermes.ready ? "Hermes is reachable through the protected server bridge." : (hermes.error || "Hermes is not reachable."), "Open Hermes Control", "#/hermes"),
      checked("obsidian-mcp", "Obsidian MCP", liveMcp.includes("mcp_obsidian"), liveMcp.includes("mcp_obsidian") ? "Agents can read, search and write approved notes." : "Obsidian MCP is not connected.", "Open MCP Servers", "#/mcp"),
      checked("mila-link", "MILA backend", mila.ok, mila.ok ? "Voice backend is reachable." : (mila.error || "MILA is not reachable."), "Open MILA integration", "#/integrations"),
      checked("integrations", "Configured integrations", connectedIntegrations.length > 0, connectedIntegrations.length ? `${connectedIntegrations.length} integrations are connected.` : "No external integration has a successful connection.", "Manage integrations", "#/integrations"),
    ]),
    section("capabilities", "Capabilities", "Agents and tools that can complete real work", [
      checked("agent-fleet", "Specialist agent fleet", fleetReady, fleetReady ? `${healthyProfileCount} persistent Hermes profiles passed a live model check.` : profileCount ? `${healthyProfileCount} of ${profileCount} profiles passed the latest live model check.` : "Hermes profiles could not be read.", "Open Agents", "#/agents"),
      checked("claude", "Claude Workspace", claude.ready && claude.auth?.loggedIn, claude.ready ? `Claude Code ${claude.version || "is installed"} and authenticated.` : (claude.error || "Claude Workspace is not ready."), "Open Claude Workspace", "#/claude-code"),
      checked("mila-voice", "MILA voice", mila.ok && mila.voiceConfigured, mila.voiceConfigured ? `Gemini Live is configured with ${mila.liveModel || "a live model"}.` : "Secure voice is not configured.", "Open MILA Live", "#/speech"),
      checked("kanban-proof", "Executed work", totalTasks > 0, totalTasks ? `${totalTasks} Kanban tasks provide an execution trail.` : "No task has been executed through the board yet.", "Open Kanban", "#/kanban"),
    ]),
    section("cadence", "Cadence", "Monitoring, backups and recurring autonomous work", [
      checked("monitor", "Host monitoring", operations.available, operations.available ? `Checks run every ${operations.schedule?.monitorEveryMinutes || 5} minutes.` : "The host monitor is not installed.", "Open Observability", "#/observability"),
      checked("health", "Incident loop", operations.status === "healthy" && !operations.activeIncidents, operations.status === "healthy" ? "Host checks are healthy with no active incidents." : `${operations.activeIncidents || 0} active incidents; host status is ${operations.status || "unknown"}.`, "Review incidents", "#/observability"),
      checked("backup", "Automated backup", operations.backup?.status === "success", operations.backup?.status === "success" ? `Last successful backup: ${operations.backup.lastSuccessAt || "recorded"}.` : "No successful automated backup is recorded.", "Create backup", "#/observability"),
      checked("restore-drill", "Backup restore drill", operations.restoreDrill?.status === "success", operations.restoreDrill?.status === "success" ? `Last verified restore: ${operations.restoreDrill.lastSuccessAt || "recorded"}.` : "No successful restore drill is recorded.", "Verify restore", "#/observability"),
      checked("scheduled-work", "Recurring agent work", activeRoutines.length > 0 || scheduledTasks > 0, activeRoutines.length ? `${activeRoutines.length} Hermes routines are active.` : scheduledTasks ? `${scheduledTasks} Kanban tasks are scheduled for autonomous execution.` : "No recurring or scheduled agent task exists yet.", "Plan recurring work", "#/routines"),
    ]),
  ];

  const score = Math.round(sections.reduce((sum, item) => sum + item.score, 0) / sections.length);
  const recommendations = sections.flatMap((item) => item.checks
    .filter((check) => !check.ok)
    .map((check) => ({ section: item.label, title: check.action, detail: check.detail, href: check.href })))
    .slice(0, 8);
  return {
    framework: "Four C",
    checkedAt: new Date().toISOString(),
    score,
    status: score >= 80 ? "ready" : score >= 50 ? "attention" : "blocked",
    sections,
    recommendations,
  };
}

const fallback = (error) => ({ ready: false, ok: false, error: error?.message || "Unavailable" });

export async function readFourCReadiness(user) {
  const operations = readOperationsState();
  const milaConfig = db.integrations.byProvider("mila")?.config || {};
  const results = await Promise.allSettled([
    knowledge.status(),
    hermesDashboardStatus(),
    claudeCode.status({ probe: false }),
    milaStatus(milaConfig, { timeoutMs: 3500 }),
    hermesKanbanRequest(kanbanPath("/profiles", config.hermesKanbanBoard), { timeoutMs: 4000 }),
    hermesKanbanRequest(kanbanPath("/board", config.hermesKanbanBoard), { timeoutMs: 4000 }),
    hermesCronRequest("/api/cron/jobs?profile=all", { timeoutMs: 5000 }),
  ]);
  const value = (index) => results[index].status === "fulfilled" ? results[index].value : fallback(results[index].reason);
  const profiles = mergeHermesFleetHealth(value(4), readHermesFleetHealth());
  return buildFourCReadiness({
    onboardingState: onboarding.get(user),
    vault: value(0),
    hermes: value(1),
    claude: value(2),
    mila: value(3),
    profiles,
    board: value(5),
    cronJobs: value(6),
    operations,
    connectedIntegrations: db.integrations.list().filter((item) => item.connected).map((item) => item.provider),
    liveMcp: db.mcp.list().filter((item) => mcp.isLive(item.id)).map((item) => item.id),
  });
}
