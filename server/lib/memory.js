import { journal } from "./journal.js";
import { knowledge } from "./knowledge.js";
import { memberWorkspaces } from "./member-workspace.js";
import { onboarding } from "./onboarding.js";

const clean = (value, max = 500) => String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
const entry = (key, scope, value, updatedAt, source) => ({
  key,
  scope,
  value: clean(value),
  updatedAt: updatedAt || null,
  source,
});

export async function readMemorySnapshot(user, dependencies = {}) {
  const onboardingStore = dependencies.onboarding || onboarding;
  const workspaceStore = dependencies.memberWorkspaces || memberWorkspaces;
  const library = dependencies.knowledge || knowledge;
  const state = onboardingStore.get(user);
  const profile = state.profile || {};
  const workspace = state.workspace || {};
  const dashboard = workspaceStore.dashboard(user.id);
  const operator = ["Creator", "Admin"].includes(user.role);
  const [vault, usage] = operator
    ? await Promise.all([
      library.status().catch(() => ({ ready: false, notes: 0 })),
      library.recentUsage(40).catch(() => []),
    ])
    : [{ ready: false, notes: 0 }, []];

  const entries = [
    entry("user.locale", "user", profile.locale, profile.updatedAt, "SOUL"),
    entry("user.timezone", "user", profile.timezone, profile.updatedAt, "SOUL"),
    entry("user.work_focus", "user", profile.roleFocus, profile.updatedAt, "SOUL"),
    entry("user.assistant_style", "user", profile.assistantStyle, profile.updatedAt, "SOUL"),
    entry("user.response_length", "user", profile.responseLength, profile.updatedAt, "SOUL"),
  ];

  if (operator) {
    entries.push(
      entry("workspace.name", "workspace", workspace.name, workspace.updatedAt, "Onboarding"),
      entry("workspace.goals", "workspace", (workspace.goals || []).join(" · "), workspace.updatedAt, "Onboarding"),
      entry("workspace.constraints", "workspace", (workspace.constraints || []).join(" · "), workspace.updatedAt, "Onboarding"),
    );
  }

  for (const note of dashboard.notes || []) {
    entries.push(entry(`note.${note.id}`, "user", note.title, note.updatedAt, "Personal notes"));
  }

  for (const event of usage.slice(0, 12)) {
    const target = event.path || event.query || event.action;
    entries.push(entry(
      `agent.${clean(event.actor, 60).replace(/[^a-zA-Z0-9_-]/g, "_")}.${event.action}`,
      "agent",
      target,
      event.at,
      "Obsidian audit",
    ));
  }

  const visible = entries.filter((item) => item.value);
  // The facts above are what the system was told; the journal is what it did.
  // Both are memory, and the screen is the only place either becomes visible.
  const journalStore = dependencies.journal || journal;
  const timeline = operator
    ? journalStore.recentEntries({ days: 7, limit: 40, timeZone: profile.timezone })
    : [];
  return {
    entries: visible,
    journal: timeline,
    stats: {
      entries: visible.length,
      personalNotes: dashboard.counts?.notes || 0,
      vaultNotes: Number(vault.notes) || 0,
      agentEvents: usage.length,
      journalEntries: timeline.length,
    },
    sources: {
      profile: profile.completedAt ? "connected" : "setup_required",
      personalNotes: "connected",
      obsidian: operator ? (vault.ready ? "connected" : "unavailable") : "restricted",
    },
    updatedAt: new Date().toISOString(),
  };
}
