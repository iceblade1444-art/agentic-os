import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { KnowledgeLibrary, OBSIDIAN_TOOLS } from "../server/lib/knowledge.js";

let root;
let library;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "agentos-knowledge-"));
  library = new KnowledgeLibrary({
    vaultDir: path.join(root, "vault"),
    usageFile: path.join(root, "data", "usage.json"),
  });
  await library.init();
});

after(async () => fs.rm(root, { recursive: true, force: true }));

test("Obsidian library creates, reads, searches and appends Markdown notes", async () => {
  const created = await library.create("Projects/Roadmap", "# Roadmap\n\nHermes integration #agentic", { actor: "Creator" });
  assert.equal(created.path, "Projects/Roadmap.md");
  assert.equal(created.title, "Roadmap");
  assert.deepEqual(created.tags, ["agentic"]);

  const appended = await library.append("Projects/Roadmap.md", "- Connect Obsidian MCP", { actor: "Hermes", source: "hermes-mcp" });
  assert.match(appended.content, /Connect Obsidian MCP/);

  const read = await library.read("Projects/Roadmap", { actor: "Research Agent", source: "agent" });
  assert.match(read.content, /Hermes integration/);
  const result = await library.search("Obsidian", { actor: "Hermes" });
  assert.equal(result.matches[0].path, "Projects/Roadmap.md");

  const status = await library.status();
  assert.equal(status.notes, 1);
  assert.equal(status.folders, 1);
  assert.deepEqual(status.tools, OBSIDIAN_TOOLS);
});

test("Obsidian library confines every operation to the vault", async () => {
  await assert.rejects(() => library.read("../outside.md"), /Invalid vault note path|escapes/);
  await assert.rejects(() => library.create(".obsidian/config.md", "no"), /Invalid vault note path/);
  await assert.rejects(() => library.create("Projects/Roadmap.md", "duplicate"), /EEXIST/);
});

test("Obsidian usage log identifies agents without storing note contents", async () => {
  const usage = await library.recentUsage(50);
  assert.equal(usage.some((entry) => entry.actor === "Hermes" && entry.action === "append"), true);
  assert.equal(usage.some((entry) => entry.actor === "Research Agent" && entry.action === "read"), true);
  assert.equal(JSON.stringify(usage).includes("Hermes integration"), false);
});

test("Knowledge panel exposes the real vault and agent audit UI", async () => {
  const [page, api, app] = await Promise.all([
    fs.readFile(new URL("../assets/js/pages/misc.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../assets/js/api.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../assets/js/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Obsidian Library/);
  assert.match(page, /How agents use this library/);
  assert.match(page, /knowledgeUsage/);
  assert.match(api, /\/api\/knowledge\/status/);
  assert.match(app, /label: "Obsidian Library"/);
});
