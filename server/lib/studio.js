import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";

const FILE = path.join(path.resolve(config.dataDir), "studio.json");
const COLLECTION_STATUSES = new Set(["planning", "research", "design", "sampling", "approved", "production", "released", "archived"]);
const MODEL_STATUSES = new Set(["idea", "research", "sketch", "technical", "sample", "review", "approved", "production", "released", "rejected"]);
const CAMPAIGN_STATUSES = new Set(["brief", "concept", "production", "review", "scheduled", "live", "measuring", "complete", "cancelled"]);
const SIGNAL_TYPES = new Set(["trend", "competitor", "mass_market", "sales", "customer"]);
const JOB_TYPES = new Set(["image", "video"]);
const JOB_STATUSES = new Set(["draft", "queued", "running", "review", "complete", "failed", "cancelled"]);

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const text = (value, limit = 500) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
const number = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Math.max(min, Math.min(max, Number(value) || 0));
const list = (value, limit = 20) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => text(item, 120)).filter(Boolean))].slice(0, limit);

function initial() {
  return {
    version: 1,
    collections: [],
    models: [],
    campaigns: [],
    signals: [],
    generationJobs: [],
  };
}

function read() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    if (!fs.existsSync(FILE)) return initial();
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const seed = initial();
    for (const key of Object.keys(seed)) if (data[key] === undefined) data[key] = seed[key];
    return data;
  } catch (error) {
    console.error("[studio] load failed:", error.message);
    return initial();
  }
}

let data = read();

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temporary = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, FILE);
  hardenRuntimeFile(FILE, 0o600);
}

function find(bucket, itemId) {
  return data[bucket].find((item) => item.id === itemId) || null;
}

function remove(bucket, itemId) {
  const before = data[bucket].length;
  data[bucket] = data[bucket].filter((item) => item.id !== itemId);
  if (data[bucket].length === before) return false;
  save();
  return true;
}

function update(bucket, itemId, patch, normalize) {
  const item = find(bucket, itemId);
  if (!item) return null;
  Object.assign(item, normalize(patch, item), { updatedAt: now() });
  save();
  return item;
}

function collectionInput(input = {}, current = {}) {
  const name = text(input.name ?? current.name, 160);
  if (!name) throw Object.assign(new Error("Collection name is required"), { status: 400 });
  const status = text(input.status ?? current.status, 40) || "planning";
  if (!COLLECTION_STATUSES.has(status)) throw Object.assign(new Error("Invalid collection status"), { status: 400 });
  return {
    name,
    season: text(input.season ?? current.season, 80),
    market: text(input.market ?? current.market, 120),
    audience: text(input.audience ?? current.audience, 160),
    theme: text(input.theme ?? current.theme, 800),
    owner: text(input.owner ?? current.owner, 120),
    status,
  };
}

function modelInput(input = {}, current = {}) {
  const name = text(input.name ?? current.name, 160);
  if (!name) throw Object.assign(new Error("Model name is required"), { status: 400 });
  const status = text(input.status ?? current.status, 40) || "idea";
  if (!MODEL_STATUSES.has(status)) throw Object.assign(new Error("Invalid model status"), { status: 400 });
  const collectionId = text(input.collectionId ?? current.collectionId, 100);
  if (collectionId && !find("collections", collectionId)) {
    throw Object.assign(new Error("Collection not found"), { status: 400 });
  }
  return {
    collectionId,
    name,
    sku: text(input.sku ?? current.sku, 80),
    category: text(input.category ?? current.category, 100),
    audience: text(input.audience ?? current.audience, 160),
    owner: text(input.owner ?? current.owner, 120),
    status,
    colors: list(input.colors ?? current.colors, 16),
    materials: list(input.materials ?? current.materials, 16),
    cost: number(input.cost ?? current.cost, 0, 1_000_000_000),
    price: number(input.price ?? current.price, 0, 1_000_000_000),
    forecastScore: number(input.forecastScore ?? current.forecastScore, 0, 100),
    targetUnits: number(input.targetUnits ?? current.targetUnits, 0, 10_000_000),
    notes: text(input.notes ?? current.notes, 4000),
    assets: (Array.isArray(input.assets ?? current.assets) ? (input.assets ?? current.assets) : [])
      .map((asset) => ({
        id: text(asset.id, 100) || id("asset"),
        type: JOB_TYPES.has(asset.type) ? asset.type : "image",
        url: text(asset.url, 2000),
        label: text(asset.label, 160),
      })).filter((asset) => asset.url).slice(0, 40),
  };
}

function campaignInput(input = {}, current = {}) {
  const name = text(input.name ?? current.name, 160);
  if (!name) throw Object.assign(new Error("Campaign name is required"), { status: 400 });
  const status = text(input.status ?? current.status, 40) || "brief";
  if (!CAMPAIGN_STATUSES.has(status)) throw Object.assign(new Error("Invalid campaign status"), { status: 400 });
  const modelIds = list(input.modelIds ?? current.modelIds, 50)
    .filter((modelId) => !!find("models", modelId));
  return {
    name,
    status,
    modelIds,
    goal: text(input.goal ?? current.goal, 1000),
    audience: text(input.audience ?? current.audience, 500),
    owner: text(input.owner ?? current.owner, 120),
    channels: list(input.channels ?? current.channels, 20),
    budget: number(input.budget ?? current.budget, 0, 1_000_000_000),
    startAt: text(input.startAt ?? current.startAt, 40),
    endAt: text(input.endAt ?? current.endAt, 40),
    brief: text(input.brief ?? current.brief, 5000),
    metrics: {
      impressions: number(input.metrics?.impressions ?? current.metrics?.impressions, 0),
      clicks: number(input.metrics?.clicks ?? current.metrics?.clicks, 0),
      conversions: number(input.metrics?.conversions ?? current.metrics?.conversions, 0),
      revenue: number(input.metrics?.revenue ?? current.metrics?.revenue, 0),
      spend: number(input.metrics?.spend ?? current.metrics?.spend, 0),
    },
  };
}

function signalInput(input = {}, current = {}) {
  const title = text(input.title ?? current.title, 200);
  if (!title) throw Object.assign(new Error("Signal title is required"), { status: 400 });
  const type = text(input.type ?? current.type, 40) || "trend";
  if (!SIGNAL_TYPES.has(type)) throw Object.assign(new Error("Invalid analytics signal type"), { status: 400 });
  return {
    type,
    title,
    summary: text(input.summary ?? current.summary, 3000),
    source: text(input.source ?? current.source, 500),
    category: text(input.category ?? current.category, 120),
    market: text(input.market ?? current.market, 120),
    score: number(input.score ?? current.score, -100, 100),
    confidence: number(input.confidence ?? current.confidence, 0, 100),
    modelIds: list(input.modelIds ?? current.modelIds, 50).filter((modelId) => !!find("models", modelId)),
    observedAt: text(input.observedAt ?? current.observedAt, 40) || now(),
  };
}

function generationInput(input = {}, current = {}) {
  const brief = text(input.brief ?? current.brief, 5000);
  if (!brief) throw Object.assign(new Error("Generation brief is required"), { status: 400 });
  const type = JOB_TYPES.has(input.type ?? current.type) ? (input.type ?? current.type) : "image";
  const status = JOB_STATUSES.has(input.status ?? current.status) ? (input.status ?? current.status) : "draft";
  return {
    type,
    status,
    brief,
    modelId: text(input.modelId ?? current.modelId, 100),
    campaignId: text(input.campaignId ?? current.campaignId, 100),
    aspectRatio: text(input.aspectRatio ?? current.aspectRatio, 20) || (type === "video" ? "9:16" : "4:5"),
    outputUrl: text(input.outputUrl ?? current.outputUrl, 2000),
    kanbanTaskId: text(input.kanbanTaskId ?? current.kanbanTaskId, 100),
    provider: "higgsfield",
    requestedBy: text(input.requestedBy ?? current.requestedBy, 120),
    error: text(input.error ?? current.error, 1000),
  };
}

function create(bucket, prefix, input, normalize) {
  const timestamp = now();
  const item = { id: id(prefix), ...normalize(input), createdAt: timestamp, updatedAt: timestamp };
  data[bucket].unshift(item);
  save();
  return item;
}

function analyticsSummary() {
  const byType = Object.fromEntries([...SIGNAL_TYPES].map((type) => [type, data.signals.filter((signal) => signal.type === type).length]));
  const liveCampaigns = data.campaigns.filter((campaign) => ["live", "measuring"].includes(campaign.status));
  const releasedModels = data.models.filter((model) => model.status === "released");
  const avgForecast = data.models.length
    ? Math.round(data.models.reduce((sum, model) => sum + model.forecastScore, 0) / data.models.length)
    : 0;
  const recommendations = data.models.map((model) => {
    const related = data.signals.filter((signal) => signal.modelIds.includes(model.id)
      || (signal.category && signal.category === model.category));
    const weighted = related.reduce((sum, signal) => sum + signal.score * (signal.confidence / 100), 0);
    const score = Math.max(-100, Math.min(100, Math.round((model.forecastScore - 50) + weighted / Math.max(1, related.length))));
    const action = score >= 35 ? "increase" : score >= 10 ? "maintain" : score <= -35 ? "stop" : score <= -10 ? "reduce" : "validate";
    return {
      modelId: model.id,
      modelName: model.name,
      action,
      score,
      confidence: related.length ? Math.round(related.reduce((sum, item) => sum + item.confidence, 0) / related.length) : 0,
      evidenceCount: related.length,
    };
  }).sort((a, b) => b.score - a.score);
  return {
    byType,
    models: data.models.length,
    releasedModels: releasedModels.length,
    campaigns: data.campaigns.length,
    liveCampaigns: liveCampaigns.length,
    avgForecast,
    recommendations,
  };
}

export const studio = {
  snapshot() {
    return {
      collections: data.collections,
      models: data.models,
      campaigns: data.campaigns,
      signals: data.signals,
      generationJobs: data.generationJobs,
      analytics: analyticsSummary(),
      higgsfield: {
        transport: "mcp",
        endpoint: "https://mcp.higgsfield.ai/mcp",
        orchestrator: "hermes",
      },
    };
  },
  collections: {
    create: (input) => create("collections", "col", input, collectionInput),
    update: (itemId, patch) => update("collections", itemId, patch, collectionInput),
    remove(itemId) {
      if (data.models.some((model) => model.collectionId === itemId)) {
        throw Object.assign(new Error("Move or delete collection models first"), { status: 409 });
      }
      return remove("collections", itemId);
    },
  },
  models: {
    create: (input) => create("models", "mdl", input, modelInput),
    update: (itemId, patch) => update("models", itemId, patch, modelInput),
    remove(itemId) {
      for (const campaign of data.campaigns) campaign.modelIds = campaign.modelIds.filter((idValue) => idValue !== itemId);
      for (const signal of data.signals) signal.modelIds = signal.modelIds.filter((idValue) => idValue !== itemId);
      return remove("models", itemId);
    },
  },
  campaigns: {
    create: (input) => create("campaigns", "cmp", input, campaignInput),
    update: (itemId, patch) => update("campaigns", itemId, patch, campaignInput),
    remove: (itemId) => remove("campaigns", itemId),
  },
  signals: {
    create: (input) => create("signals", "sig", input, signalInput),
    update: (itemId, patch) => update("signals", itemId, patch, signalInput),
    remove: (itemId) => remove("signals", itemId),
  },
  generations: {
    create: (input) => create("generationJobs", "gen", input, generationInput),
    update: (itemId, patch) => update("generationJobs", itemId, patch, generationInput),
    remove: (itemId) => remove("generationJobs", itemId),
  },
};

