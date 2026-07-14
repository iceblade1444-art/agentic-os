const cleanBaseUrl = (value) => {
  const raw = String(value || "").trim().replace(/\/$/, "");
  let url;
  try { url = new URL(raw); } catch { throw new Error("Invalid MILA backend URL"); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("MILA backend URL must use HTTP(S)");
  return url.toString().replace(/\/$/, "");
};

export async function milaRequest(cfg = {}, pathname, options = {}) {
  const baseUrl = cleanBaseUrl(cfg.baseUrl);
  const adminToken = String(cfg.adminToken || "").trim();
  if (!adminToken) throw new Error("Missing MILA admin token");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 9000);
  try {
    const response = await (options.fetchImpl || fetch)(baseUrl + pathname, {
      method: options.method || "GET",
      headers: {
        "X-Admin-Token": adminToken,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `MILA HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("MILA request timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const milaStatus = (cfg, options) => milaRequest(cfg, "/admin/status", options);
export const milaConnectionCode = (cfg, label, options) => milaRequest(cfg, "/admin/connection-code", {
  ...options, method: "POST", body: { label },
});
export const milaSetSubscription = (cfg, subscription, options) => milaRequest(cfg, "/admin/subscription", {
  ...options, method: "POST", body: subscription,
});
export const milaSetAppUpdate = (cfg, update, options) => milaRequest(cfg, "/admin/app/update", {
  ...options, method: "POST", body: update,
});
