import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { journal } from "./journal.js";
import { personalProfiles } from "./personal-profile.js";
import { hardenRuntimeFile } from "./runtime-files.js";

const LOCALES = new Set(["ru-RU", "uz-UZ", "en-US"]);
const STYLES = new Set(["assistant", "friend", "operator", "mentor"]);
const LENGTHS = new Set(["brief", "balanced"]);
const LANGUAGES = new Set(["Russian", "Uzbek", "English"]);

const text = (value, max) => String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
// The day planner needs real working hours, so they are stored as validated
// HH:MM rather than prose: anything malformed falls back to the default instead
// of silently shifting someone's whole schedule.
const clock = (value, fallback) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text(value, 5));
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return fallback;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};
const list = (value, maxItems = 6, maxChars = 300) => [...new Set(
  (Array.isArray(value) ? value : String(value || "").split("\n"))
    .map((item) => text(item, maxChars)).filter(Boolean),
)].slice(0, maxItems);

function emptyData() {
  return { version: 1, workspace: {}, users: {} };
}

export class OnboardingStore {
  constructor(filePath = path.join(path.resolve(config.dataDir), "onboarding.json")) {
    this.filePath = filePath;
    this.data = this.#load();
  }

  #load() {
    try {
      if (!fs.existsSync(this.filePath)) return emptyData();
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        version: 1,
        workspace: parsed?.workspace && typeof parsed.workspace === "object" ? parsed.workspace : {},
        users: parsed?.users && typeof parsed.users === "object" ? parsed.users : {},
      };
    } catch {
      return emptyData();
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    hardenRuntimeFile(this.filePath, 0o600);
  }

  get(user) {
    const profile = this.data.users[user.id] || {};
    const canEditWorkspace = ["Creator", "Admin", "CEO"].includes(user.role);
    const workspace = canEditWorkspace ? (this.data.workspace || {}) : {};
    return {
      version: 1,
      needsOnboarding: !profile.completedAt || (canEditWorkspace && !workspace.completedAt),
      canEditWorkspace,
      profile,
      workspace,
    };
  }

  update(user, input = {}) {
    const current = this.get(user);
    const now = new Date().toISOString();
    const profileInput = input.profile || {};
    const locale = LOCALES.has(profileInput.locale) ? profileInput.locale : "ru-RU";
    const assistantStyle = STYLES.has(profileInput.assistantStyle) ? profileInput.assistantStyle : "assistant";
    const responseLength = LENGTHS.has(profileInput.responseLength) ? profileInput.responseLength : "brief";
    const workdayStart = clock(profileInput.workdayStart, current.profile.workdayStart || "09:00");
    const workdayEnd = clock(profileInput.workdayEnd, current.profile.workdayEnd || "18:00");
    const profile = {
      locale,
      timezone: text(profileInput.timezone || "Asia/Tashkent", 80),
      roleFocus: text(profileInput.roleFocus, 160),
      assistantStyle,
      responseLength,
      // An end before the start would leave the planner with no day at all.
      workdayStart: workdayEnd > workdayStart ? workdayStart : "09:00",
      workdayEnd: workdayEnd > workdayStart ? workdayEnd : "18:00",
      lunchStart: clock(profileInput.lunchStart, current.profile.lunchStart || "13:00"),
      lunchEnd: clock(profileInput.lunchEnd, current.profile.lunchEnd || "14:00"),
      briefTime: clock(profileInput.briefTime, current.profile.briefTime || "08:00"),
      // Empty means "do not post to a channel": automatic messages are opt-in,
      // so nobody's team channel fills up because a setting defaulted on.
      briefChannel: text(profileInput.briefChannel ?? current.profile.briefChannel, 80),
      alertChannel: text(profileInput.alertChannel ?? current.profile.alertChannel, 80),
      briefEnabled: profileInput.briefEnabled === undefined
        ? current.profile.briefEnabled !== false
        : !!profileInput.briefEnabled,
      // Off unless asked for: an assistant that starts speaking on its own one
      // morning is an assistant people mute, and a muted channel delivers
      // nothing at all.
      briefVoice: profileInput.briefVoice === undefined
        ? current.profile.briefVoice === true
        : !!profileInput.briefVoice,
      completedAt: current.profile.completedAt || now,
      updatedAt: now,
    };

    let workspace = current.workspace;
    if (current.canEditWorkspace) {
      const workspaceInput = input.workspace || {};
      const name = text(workspaceInput.name, 140);
      if (name.length < 2) {
        const error = new Error("Workspace name must contain at least 2 characters");
        error.code = "invalid_workspace";
        throw error;
      }
      workspace = {
        name,
        industry: text(workspaceInput.industry, 140),
        summary: text(workspaceInput.summary, 1200),
        audience: text(workspaceInput.audience, 600),
        products: text(workspaceInput.products, 1200),
        goals: list(workspaceInput.goals),
        constraints: list(workspaceInput.constraints),
        operatingLanguages: list(workspaceInput.operatingLanguages, 3, 30).filter((item) => LANGUAGES.has(item)),
        completedAt: current.workspace.completedAt || now,
        updatedAt: now,
        updatedBy: user.id,
      };
    }

    this.data.users[user.id] = profile;
    if (current.canEditWorkspace) this.data.workspace = workspace;
    this.#save();
    return this.get(user);
  }

  remove(userId) {
    if (!Object.hasOwn(this.data.users, userId)) return false;
    delete this.data.users[userId];
    this.#save();
    return true;
  }
}

const bulletList = (items, fallback = "Not specified") =>
  items?.length ? items.map((item) => `- ${item}`).join("\n") : `- ${fallback}`;

export const safeUserSlug = (user) =>
  String(user?.id || user?.email || user?.name || "user").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);

export function userSoulDocument(user, state) {
  const profile = state.profile || {};
  const workspace = state.workspace || {};
  const safeUserId = safeUserSlug(user);
  return {
    path: `Agentic OS/People/${safeUserId}/SOUL.md`,
    content: `---
type: agentic-os-user-soul
user_id: ${safeUserId}
updated: ${profile.updatedAt || new Date().toISOString()}
---

# ${user.name}

This is the durable personal operating profile for MILA, Hermes and Agentic OS agents.

## Identity

- Account: ${user.email || user.id || "Not specified"}
- Role: ${user.role || "User"}
- Workspace: ${workspace.name || "Agentic OS"}
- Timezone: ${profile.timezone || "Asia/Tashkent"}
- Preferred interface and voice language: ${profile.locale || "ru-RU"}
- Work focus: ${profile.roleFocus || "Not specified"}
- Working hours: ${profile.workdayStart || "09:00"}–${profile.workdayEnd || "18:00"} local, lunch ${profile.lunchStart || "13:00"}–${profile.lunchEnd || "14:00"}
- Morning brief: ${profile.briefEnabled === false ? "off" : `at ${profile.briefTime || "08:00"} local`}

## Assistant Preferences

- MILA style: ${profile.assistantStyle || "assistant"}
- Voice answer length: ${profile.responseLength || "brief"}
- Voice behavior: answer briefly first; offer details when needed.
- Language behavior: understand Russian, Uzbek and English; answer in the user's latest language and prefer Uzbek Latin for Uzbek.

## Safety Boundaries

- Ask for confirmation before changing files, settings, accounts, money, deployments or public services.
- Use Agentic OS Kanban for real work; do not claim a task is done until the server state confirms it.
- Store durable preferences here or in nearby personal memory notes; do not store secrets.

## Agent Routing

- MILA handles live voice, short chat, capture and user-facing clarification.
- Hermes orchestrates multi-step work and specialist agents.
- Obsidian is the long-term knowledge library.
- Claude Code is for implementation work after explicit approval.
`,
  };
}

export function onboardingContextDocuments(user, state) {
  const workspace = state.workspace;
  const profile = state.profile;
  const safeUserId = safeUserSlug(user);
  const personalDocuments = [
    {
      path: `Agentic OS/People/${safeUserId}.md`,
      content: `---
type: agentic-os-user-context
user_id: ${safeUserId}
updated: ${profile.updatedAt}
---

# ${user.name}

- Role: ${user.role}
- Preferred language: ${profile.locale}
- Timezone: ${profile.timezone}
- Work focus: ${profile.roleFocus || "Not specified"}
- MILA style: ${profile.assistantStyle}
- Voice answer length: ${profile.responseLength}
`,
    },
    userSoulDocument(user, state),
  ];
  if (!["Creator", "Admin", "CEO"].includes(user.role)) return personalDocuments;
  return [
    {
      path: "Agentic OS/Workspace Context.md",
      content: `---
type: agentic-os-workspace-context
updated: ${workspace.updatedAt}
---

# ${workspace.name}

This is the shared business context for Hermes, MILA, Claude and specialist agents.

## Business

- Industry: ${workspace.industry || "Not specified"}
- Operating languages: ${workspace.operatingLanguages?.join(", ") || "Not specified"}
- Audience: ${workspace.audience || "Not specified"}

## What We Do

${workspace.summary || "Not specified"}

## Products And Services

${workspace.products || "Not specified"}

## Current Goals

${bulletList(workspace.goals)}

## Constraints

${bulletList(workspace.constraints)}
`,
    },
    ...personalDocuments,
  ];
}

export const onboarding = new OnboardingStore();

// Playbooks are vault notes the team writes by hand and every agent then gets
// for free. Onboarding fields are one-liners; this is where the depth lives —
// brand voice, audience segments, channel rules — without touching any code.
export const AGENT_PLAYBOOKS = [
  { file: "Agentic OS/Marketing Playbook.md", label: "Marketing and content playbook" },
];
// Consumers clamp the shared context at CONTEXT_BUDGET characters, so playbooks are added
// last and only into what is left: a long playbook can lose its own tail, never
// the workspace facts or the user profile above it.
export const CONTEXT_BUDGET = 9000;
// The journal is capped well below the whole budget: it must inform the agent,
// never crowd out the workspace facts and the playbook it sits between.
export const JOURNAL_CONTEXT_BUDGET = 1800;
const MIN_PLAYBOOK_ROOM = 400;

export function readAgentPlaybook(entry, room = CONTEXT_BUDGET, vault = config.obsidianVault) {
  if (room < MIN_PLAYBOOK_ROOM) return "";
  try {
    const root = path.resolve(vault);
    const file = path.resolve(root, entry.file);
    // Keep reads inside the vault even if a playbook entry is ever mis-edited.
    if (file !== root && !file.startsWith(root + path.sep)) return "";
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return "";
    // Front matter is bookkeeping for Obsidian, not context for an agent.
    const body = fs.readFileSync(file, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
    return body.slice(0, room);
  } catch {
    return "";
  }
}

export function sharedAgentContext(
  user,
  state = onboarding.get(user || { id: "system", role: "Viewer" }),
  { vault = config.obsidianVault, journal: journalStore = journal, profiles = personalProfiles, audience = "owner" } = {},
) {
  // Who ends up reading what this agent writes. "owner" means the answer goes
  // back to the person who asked and nobody else — the web MILA, the phone, a
  // direct thread. "shared" means it is published where colleagues read it, and
  // then two things in here become a leak rather than context: the person's
  // private profile, and the day journal, which carries what everyone else did.
  // The model is asked not to repeat them, but a prompt is a request; the only
  // reliable way not to say something in a room is not to know it there.
  const forOwnerOnly = audience !== "shared";
  const workspace = state.workspace || {};
  const profile = state.profile || {};
  const context = [];
  if (workspace.completedAt && ["Creator", "Admin", "CEO"].includes(user?.role)) {
    context.push(
      "Authoritative Agentic OS workspace context:",
      `Workspace: ${workspace.name || "Not specified"}`,
      `Industry: ${workspace.industry || "Not specified"}`,
      `Business: ${workspace.summary || "Not specified"}`,
      `Audience: ${workspace.audience || "Not specified"}`,
      `Products and services: ${workspace.products || "Not specified"}`,
      `Goals:\n${bulletList(workspace.goals)}`,
      `Constraints:\n${bulletList(workspace.constraints)}`,
      `Operating languages: ${workspace.operatingLanguages?.join(", ") || "Not specified"}`,
    );
  }
  if (user?.name) {
    context.push(
      `Current user: ${user.name} (${user.role || "User"})`,
      `User language: ${profile.locale || "Not specified"}`,
      `User timezone: ${profile.timezone || "Not specified"}`,
      `User work focus: ${profile.roleFocus || "Not specified"}`,
    );
    // What this person told MILA about themselves. Private to them: stored per
    // user outside the vault, and only ever loaded when the answer goes back to
    // them alone.
    const personal = forOwnerOnly ? profiles.contextBlock(user.id) : "";
    if (personal) context.push(`What ${user.name} has told you about themselves:
${personal}`);
  }
  let out = context.join("\n").slice(0, CONTEXT_BUDGET);
  if (!(forOwnerOnly && workspace.completedAt && ["Creator", "Admin", "CEO"].includes(user?.role))) return out;

  // The other half of the memory loop. Facts and playbooks flow down into every
  // agent; without this, nothing flowed back, so each session began knowing
  // nothing about the last one. The journal goes in before the playbooks because
  // it is the part that changes daily — a playbook is stable and can be re-read
  // from the vault, yesterday's decisions cannot.
  const journalHeading = "\nWhat Agentic OS did recently (day journal, newest last):\n";
  const room = Math.min(JOURNAL_CONTEXT_BUDGET, CONTEXT_BUDGET - out.length - journalHeading.length);
  const recent = room > 200 ? journalStore.recentText({ budget: room, timeZone: profile.timezone }) : "";
  if (recent) out += `${journalHeading}${recent}\n`;

  for (const entry of AGENT_PLAYBOOKS) {
    const heading = `\n${entry.label} (authoritative, written by the team):\n`;
    const playbook = readAgentPlaybook(entry, CONTEXT_BUDGET - out.length - heading.length, vault);
    if (playbook) out += `${heading}${playbook}`;
  }
  return out;
}
