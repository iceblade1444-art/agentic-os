import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";

const LOCALES = new Set(["ru-RU", "uz-UZ", "en-US"]);
const STYLES = new Set(["assistant", "friend", "operator", "mentor"]);
const LENGTHS = new Set(["brief", "balanced"]);
const LANGUAGES = new Set(["Russian", "Uzbek", "English"]);

const text = (value, max) => String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
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
    const canEditWorkspace = ["Creator", "Admin"].includes(user.role);
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
    const profile = {
      locale,
      timezone: text(profileInput.timezone || "Asia/Tashkent", 80),
      roleFocus: text(profileInput.roleFocus, 160),
      assistantStyle,
      responseLength,
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
  if (!["Creator", "Admin"].includes(user.role)) return personalDocuments;
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

export function sharedAgentContext(user, state = onboarding.get(user || { id: "system", role: "Viewer" })) {
  const workspace = state.workspace || {};
  const profile = state.profile || {};
  const context = [];
  if (workspace.completedAt && ["Creator", "Admin"].includes(user?.role)) {
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
  }
  return context.join("\n").slice(0, 6000);
}
