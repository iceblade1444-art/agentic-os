// Direct Higgsfield Platform API client (https://platform.higgsfield.ai).
// Auth: "Authorization: Key {key}:{secret}". A generation is submitted to
// POST /{model_id} and polled at GET /requests/{request_id}/status.
// Dependencies (config section, fetch) are parameters so every branch is testable.
import { config } from "../config.js";

const DEFAULT_IMAGE_MODELS = [
  { id: "higgsfield-ai/soul/standard", label: "Higgsfield Soul" },
  { id: "reve/text-to-image", label: "Reve" },
];
// Model ids differ between the Platform API and the MCP connector catalog.
const DEFAULT_MCP_IMAGE_MODELS = [
  { id: "soul_2", label: "Higgsfield Soul 2" },
  { id: "nano_banana_pro", label: "Nano Banana Pro" },
  { id: "marketing_studio_image", label: "Marketing Studio" },
];
const FAILED_STATUSES = new Set(["failed", "error", "nsfw", "canceled", "cancelled"]);

export function higgsfieldEnabled(higgsfield = config.higgsfield) {
  return !!(higgsfield.apiKey && higgsfield.apiSecret);
}

export function higgsfieldImageModels(higgsfield = config.higgsfield, mode = "api") {
  const configured = String(higgsfield.imageModels || "").split(",").map((entry) => {
    const [id, label] = entry.split("|").map((part) => part.trim());
    return id ? { id, label: label || id } : null;
  }).filter(Boolean);
  if (configured.length) return configured;
  return mode === "mcp" ? DEFAULT_MCP_IMAGE_MODELS : DEFAULT_IMAGE_MODELS;
}

async function request(path, options, higgsfield, fetchImpl) {
  if (!higgsfieldEnabled(higgsfield)) {
    throw Object.assign(new Error("Higgsfield API keys are not configured"), { status: 503, code: "higgsfield_disabled" });
  }
  const res = await fetchImpl(`${higgsfield.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Key ${higgsfield.apiKey}:${higgsfield.apiSecret}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : body.error || "";
    throw Object.assign(new Error(detail || `Higgsfield request failed (${res.status})`), { status: 502 });
  }
  return body;
}

export async function submitImage(input, higgsfield = config.higgsfield, fetchImpl = fetch) {
  const models = higgsfieldImageModels(higgsfield);
  const model = models.some((item) => item.id === input.model) ? input.model : models[0].id;
  const body = { prompt: input.prompt, aspect_ratio: input.aspectRatio || "1:1" };
  if (input.quality) body.resolution = input.quality;
  const result = await request(`/${model}`, { method: "POST", body: JSON.stringify(body) }, higgsfield, fetchImpl);
  if (!result.request_id) throw Object.assign(new Error("Higgsfield did not return a request id"), { status: 502 });
  return { requestId: String(result.request_id), model };
}

export async function pollRequest(requestId, higgsfield = config.higgsfield, fetchImpl = fetch) {
  const result = await request(`/requests/${encodeURIComponent(requestId)}/status`, {}, higgsfield, fetchImpl);
  const status = String(result.status || "queued");
  const images = (Array.isArray(result.images) ? result.images : [])
    .map((item) => String(item?.url || "")).filter(Boolean);
  const failed = FAILED_STATUSES.has(status);
  return {
    status,
    done: status === "completed",
    failed,
    outputUrl: images[0] || String(result.video?.url || ""),
    images,
    error: failed ? String(result.error || result.detail || `Higgsfield status: ${status}`) : "",
  };
}
