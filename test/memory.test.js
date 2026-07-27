import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { readMemorySnapshot } from "../server/lib/memory.js";

test("memory snapshot uses server profile, notes and Obsidian audit", async () => {
  const user = { id: "creator", name: "Creator", role: "Creator" };
  const result = await readMemorySnapshot(user, {
    onboarding: {
      get: () => ({
        profile: {
          locale: "uz-UZ",
          timezone: "Asia/Tashkent",
          roleFocus: "Product",
          assistantStyle: "mentor",
          responseLength: "brief",
          completedAt: "2026-07-27T10:00:00.000Z",
          updatedAt: "2026-07-27T10:00:00.000Z",
        },
        workspace: {
          name: "Milana Premium",
          goals: ["Ship Agentic OS"],
          constraints: ["Confirm deployments"],
          updatedAt: "2026-07-27T09:00:00.000Z",
        },
      }),
    },
    memberWorkspaces: {
      dashboard: () => ({
        counts: { notes: 1 },
        notes: [{ id: "note_1", title: "Launch notes", updatedAt: "2026-07-27T11:00:00.000Z" }],
      }),
    },
    knowledge: {
      status: async () => ({ ready: true, notes: 7 }),
      recentUsage: async () => [{
        actor: "Hermes",
        action: "search",
        query: "release",
        at: "2026-07-27T12:00:00.000Z",
      }],
    },
  });

  assert.equal(result.stats.personalNotes, 1);
  assert.equal(result.stats.vaultNotes, 7);
  assert.equal(result.entries.some((item) => item.key === "user.locale" && item.value === "uz-UZ"), true);
  assert.equal(result.entries.some((item) => item.key === "workspace.goals"), true);
  assert.equal(result.entries.some((item) => item.source === "Personal notes"), true);
  assert.equal(result.entries.some((item) => item.source === "Obsidian audit"), true);
});

test("Memory UI no longer contains fabricated localStorage metrics", () => {
  const page = fs.readFileSync(new URL("../assets/js/pages/misc.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");

  assert.doesNotMatch(page, /18\.4K/);
  assert.doesNotMatch(page, /Recall hits/);
  assert.doesNotMatch(page, /ensure\("mems"/);
  assert.match(page, /api\.memory\.snapshot/);
  assert.match(api, /snapshot: \(\) => j\("\/api\/memory"\)/);
});

test("member memory never reads shared workspace or Obsidian audit", async () => {
  let sharedReads = 0;
  const result = await readMemorySnapshot({ id: "member_1", name: "Member", role: "Member" }, {
    onboarding: {
      get: () => ({
        profile: { locale: "ru-RU", completedAt: "2026-07-27T10:00:00.000Z" },
        workspace: { name: "Private operator workspace", goals: ["Hidden"] },
      }),
    },
    memberWorkspaces: {
      dashboard: () => ({
        counts: { notes: 1 },
        notes: [{ id: "own", title: "Own note", updatedAt: "2026-07-27T11:00:00.000Z" }],
      }),
    },
    knowledge: {
      status: async () => { sharedReads += 1; return { ready: true, notes: 99 }; },
      recentUsage: async () => { sharedReads += 1; return [{ actor: "Hermes", path: "Hidden.md" }]; },
    },
  });

  assert.equal(sharedReads, 0);
  assert.equal(result.sources.obsidian, "restricted");
  assert.equal(result.entries.some((item) => item.scope === "workspace"), false);
  assert.equal(result.entries.some((item) => item.source === "Obsidian audit"), false);
  assert.equal(result.entries.some((item) => item.value === "Own note"), true);
});
