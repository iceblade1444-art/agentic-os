// Brain search — one query across everything the OS holds: vault notes,
// board tasks, chats, missions, routines, skills, studio artifacts, memory,
// live ERP. Each source is independent and time-boxed, so a dead runtime
// costs its own rows and never the answer — and the reply always says which
// sources it actually heard from, because a partial answer that looks whole
// is worse than a slow one.
import { config } from "../config.js";
import * as mcp from "../mcp/manager.js";
import { db } from "../store.js";
import { hermesCronRequest, hermesKanbanRequest, hermesSkillsRequest, kanbanPath } from "./hermes-kanban.js";
import { knowledge } from "./knowledge.js";
import { readMemorySnapshot } from "./memory.js";
import { messenger } from "./messenger.js";
import { studio } from "./studio.js";

const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const hit = (type, title, route, extra = {}) => ({
  type, route,
  title: clip(title, 160),
  snippet: clip(extra.snippet, 220),
  id: extra.id ? clip(extra.id, 200) : undefined,
  // Where it lives and when it was last touched: a search over a second
  // brain is a search over memories, and a memory without a date is a fact
  // with no idea how stale it is.
  where: extra.where ? clip(extra.where, 120) : undefined,
  at: extra.at || undefined,
});
const has = (needle) => (text) => String(text || "").toLowerCase().includes(needle);
const asArray = (value, key) => Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : [];

export async function searchBrain(query, sources, { limit = 30, perSource = 6, timeoutMs = 1800 } = {}) {
  const q = clip(query, 200);
  if (q.length < 2) {
    const error = new Error("Query must be at least 2 characters");
    error.status = 400;
    throw error;
  }
  const needle = q.toLowerCase();
  const settled = await Promise.all(sources.map(async (source) => {
    let timer = null;
    try {
      const rows = await Promise.race([
        source.run(needle, perSource),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), timeoutMs); }),
      ]);
      const results = (rows || []).slice(0, perSource);
      return { name: source.name, ok: true, count: results.length, results };
    } catch (error) {
      return { name: source.name, ok: false, count: 0, error: clip(error.message, 120), results: [] };
    } finally {
      clearTimeout(timer);
    }
  }));
  // Source order is priority order; exact-title hits float above their peers.
  const results = settled.flatMap((entry) => entry.results)
    .sort((a, b) => {
      const rank = (row) => row.title.toLowerCase().startsWith(needle) ? 0 : 1;
      return rank(a) - rank(b);
    })
    .slice(0, Math.min(100, Math.max(1, Number(limit) || 30)));
  return {
    query: q,
    results,
    sources: settled.map(({ results: _, ...meta }) => meta),
    partial: settled.some((entry) => !entry.ok),
  };
}

export function defaultSources(user) {
  const actor = user?.name || "operator";
  return [
    {
      name: "notes",
      async run(needle, perSource) {
        const found = await knowledge.search(needle, { limit: perSource, actor, source: "brain-search" });
        return asArray(found, "matches").concat(asArray(found?.matches ? [] : found, "results"))
          .map((note) => hit("note", note.title || note.path, "knowledge", {
            snippet: note.snippet, id: note.path, at: note.updatedAt, where: note.folder,
          }));
      },
    },
    {
      name: "tasks",
      async run(needle, perSource) {
        const board = await hermesKanbanRequest(kanbanPath("/board", config.hermesKanbanBoard));
        const match = has(needle);
        return asArray(board, "columns").flatMap((column) => asArray(column, "tasks")
          .filter((task) => match(task.title) || match(task.description))
          .map((task) => hit("task", task.title || task.id, "kanban", {
            snippet: `${task.status || column.name || ""}${task.assignee ? ` · ${task.assignee}` : ""}`,
            id: task.id, at: task.updated_at || task.created_at, where: column.name,
          }))).slice(0, perSource);
      },
    },
    {
      name: "chats",
      async run(needle, perSource) {
        if (!user?.id) return [];
        return messenger.search(user.id, needle, { limit: perSource })
          .map((row) => hit("chat", row.conversationName || "Chat", "chat", {
            snippet: row.message?.text, id: row.conversationId, at: row.message?.createdAt, where: row.conversationName,
          }));
      },
    },
    {
      name: "missions",
      async run(needle, perSource) {
        const match = has(needle);
        return db.missions.list()
          .filter((mission) => match(mission.title) || match(mission.goal))
          .slice(0, perSource)
          .map((mission) => hit("mission", mission.title, "missions", { snippet: mission.goal, id: mission.id, at: mission.createdAt }));
      },
    },
    {
      name: "routines",
      async run(needle, perSource) {
        const jobs = await hermesCronRequest("/api/cron/jobs?profile=all");
        const match = has(needle);
        return asArray(jobs, "jobs")
          .filter((job) => match(job.name) || match(job.prompt))
          .slice(0, perSource)
          .map((job) => hit("routine", job.name || job.id, "routines", { snippet: job.schedule, id: job.id || job.name }));
      },
    },
    {
      name: "skills",
      async run(needle, perSource) {
        const skills = await hermesSkillsRequest("/api/skills");
        const match = has(needle);
        return asArray(skills, "skills")
          .filter((skill) => match(skill.name) || match(skill.category) || match(skill.description))
          .slice(0, perSource)
          .map((skill) => hit("skill", `/${skill.name}`, "tools", { snippet: skill.description || skill.category, id: skill.name }));
      },
    },
    {
      name: "studio",
      async run(needle, perSource) {
        const snapshot = studio.snapshot();
        const match = has(needle);
        const buckets = [
          ["collections", "design"], ["models", "design"], ["campaigns", "media"], ["generationJobs", "media"],
        ];
        const rows = [];
        for (const [bucket, route] of buckets) {
          for (const item of asArray(snapshot[bucket], bucket)) {
            if (rows.length >= perSource) break;
            if (match(item.name) || match(item.title) || match(item.prompt) || match(item.sku)) {
              rows.push(hit("studio", item.name || item.title || item.id, route, { snippet: item.notes || item.prompt, id: item.id }));
            }
          }
        }
        return rows;
      },
    },
    {
      name: "memory",
      async run(needle, perSource) {
        const snapshot = await readMemorySnapshot(user);
        const match = has(needle);
        return asArray(snapshot?.vault?.usage || snapshot?.usage, "entries")
          .filter((entry) => match(entry.path) || match(entry.action))
          .slice(0, perSource)
          .map((entry) => hit("memory", entry.path || entry.action, "memory", { snippet: entry.actor, at: entry.at }));
      },
    },
    {
      // Live only: connecting the ERP bridge spawns a process, which no
      // search keystroke should ever do. Offline reads as an honest miss.
      name: "erp",
      async run(needle, perSource) {
        if (!mcp.isLive("mcp_erp")) throw new Error("ERP bridge offline");
        const raw = await mcp.callTool("mcp_erp", "erp_search", { query: needle, limit_per_type: 3 });
        const text = raw?.content?.find((item) => item.type === "text")?.text || "";
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { return []; }
        const rows = [];
        const walk = (value, label) => {
          if (rows.length >= perSource) return;
          if (Array.isArray(value)) {
            for (const item of value) {
              if (rows.length >= perSource) break;
              if (item && typeof item === "object") {
                const title = item.name || item.title || item.code || item.label;
                if (title) rows.push(hit("erp", title, "erp", { snippet: label, id: item.code || item.id }));
              }
            }
            return;
          }
          if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) walk(child, key);
        };
        walk(parsed.data ?? parsed, "");
        return rows;
      },
    },
  ];
}
