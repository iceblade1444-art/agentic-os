import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Studio persists a complete product-to-media workflow and explains recommendations", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-studio-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  process.env.DATA_DIR = directory;

  const { studio } = await import(`../server/lib/studio.js?test=${Date.now()}`);
  const collection = studio.collections.create({
    name: "Autumn 2026", season: "AW26", market: "Uzbekistan", status: "design",
  });
  const model = studio.models.create({
    collectionId: collection.id, name: "Structured wool coat", sku: "AW26-COAT-01",
    category: "outerwear", cost: 100, price: 280, forecastScore: 76, targetUnits: 500,
  });
  const signal = studio.signals.create({
    type: "sales", title: "Outerwear sell-through above plan", category: "outerwear",
    score: 45, confidence: 90, source: "ERP weekly report", modelIds: [model.id],
  });
  const campaign = studio.campaigns.create({
    name: "AW26 launch", status: "production", modelIds: [model.id],
    channels: ["Instagram", "Telegram"], budget: 1200,
  });
  const generation = studio.generations.create({
    type: "video", brief: "Create a vertical product film with fabric close-ups.",
    aspectRatio: "9:16", modelId: model.id, campaignId: campaign.id,
  });
  const snapshot = studio.snapshot();

  assert.equal(snapshot.collections[0].id, collection.id);
  assert.equal(snapshot.models[0].collectionId, collection.id);
  assert.deepEqual(snapshot.campaigns[0].modelIds, [model.id]);
  assert.equal(snapshot.signals[0].id, signal.id);
  assert.equal(snapshot.generationJobs[0].provider, "higgsfield");
  assert.equal(snapshot.generationJobs[0].id, generation.id);
  assert.equal(snapshot.higgsfield.endpoint, "https://mcp.higgsfield.ai/mcp");
  assert.equal(snapshot.analytics.byType.sales, 1);
  assert.equal(snapshot.analytics.recommendations[0].action, "increase");
  assert.equal(snapshot.analytics.recommendations[0].evidenceCount, 1);
  assert.equal(fs.existsSync(path.join(directory, "studio.json")), true);

  const imageJob = studio.generations.create({
    type: "image", brief: "Hero image on a beige studio backdrop.", modelId: model.id,
    engine: "reve/text-to-image", higgsfieldRequestId: "req_local",
  });
  assert.equal(imageJob.engine, "reve/text-to-image");
  assert.equal(imageJob.higgsfieldRequestId, "req_local");
  assert.equal(studio.generations.attachOutput(imageJob.id), null);
  studio.generations.update(imageJob.id, { status: "complete", outputUrl: "https://cdn.higgsfield.ai/renders/coat-hero.png" });
  const attached = studio.generations.attachOutput(imageJob.id);
  assert.equal(attached.id, model.id);
  assert.equal(attached.assets[0].url, "https://cdn.higgsfield.ai/renders/coat-hero.png");
  assert.equal(studio.generations.attachOutput(imageJob.id).assets.length, 1);
});

test("Studio rejects broken references and unsafe lifecycle values", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-studio-invalid-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  process.env.DATA_DIR = directory;

  const { studio } = await import(`../server/lib/studio.js?invalid=${Date.now()}`);
  assert.throws(() => studio.collections.create({ name: "", status: "planning" }), /required/);
  assert.throws(() => studio.models.create({ name: "Bad model", collectionId: "missing" }), /not found/);
  assert.throws(() => studio.signals.create({ title: "Bad signal", type: "rumor" }), /Invalid/);

  const collection = studio.collections.create({ name: "Protected collection" });
  studio.models.create({ name: "Attached model", collectionId: collection.id });
  assert.throws(() => studio.collections.remove(collection.id), /Move or delete/);
});

test("Studio pages are operator-only and generation jobs route through Hermes", () => {
  const index = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../server/routes/studio.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../assets/js/pages/studio.js", import.meta.url), "utf8");

  assert.match(index, /app\.use\("\/api\/studio", requireOperator, studio\)/);
  assert.match(route, /Use the official Higgsfield MCP connector/);
  assert.match(route, /assignee:\s*"reach"/);
  assert.match(route, /config\.hermesKanbanBoard/);
  assert.match(route, /attachOutput/);
  assert.match(route, /generations\/:id\/run/);
  assert.match(route, /generations\/:id\/poll/);
  assert.match(app, /\{\s*group:\s*"Studio"/);
  assert.match(app, /design,\s*media,\s*analytics/);
  assert.match(page, /studio\.design\.imageGeneration/);
});
