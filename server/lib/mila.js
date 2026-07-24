const cleanBaseUrl = (value) => {
  const raw = String(value || "").trim().replace(/\/$/, "");
  let url;
  try { url = new URL(raw); } catch { throw new Error("Invalid MILA backend URL"); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("MILA backend URL must use HTTP(S)");
  return url.toString().replace(/\/$/, "");
};

const dashboardSessions = new Map();

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

async function milaSessionRequest(cfg = {}, pathname, options = {}) {
  const baseUrl = cleanBaseUrl(cfg.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    const response = await (options.fetchImpl || fetch)(baseUrl + pathname, {
      method: options.method || "POST",
      headers: {
        ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}),
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
export const milaConnectionCode = (cfg, label, options = {}) => milaRequest(cfg, "/admin/connection-code", {
  ...options, method: "POST", body: { label, ...(options.owner ? { owner: options.owner } : {}) },
});
export const milaDevices = (cfg, options) => milaRequest(cfg, "/admin/devices", options);
export const milaRevokeDevice = (cfg, id, options) => {
  if (!/^[a-f0-9]{32}$/.test(String(id || ""))) throw new Error("Invalid MILA device ID");
  return milaRequest(cfg, `/admin/devices/${id}`, { ...options, method: "DELETE" });
};

// Mint a constrained Gemini Live token without exposing MILA's admin token,
// account session, or long-lived provider key to the browser.
export async function milaVoiceToken(cfg, label = "Agentic OS dashboard", options = {}) {
  const cacheKey = cleanBaseUrl(cfg.baseUrl);
  let sessionToken = dashboardSessions.get(cacheKey);
  if (!sessionToken) {
    const connection = await milaConnectionCode(cfg, label, options);
    if (!connection.code) throw new Error("MILA did not create a connection code");
    const session = await milaSessionRequest(cfg, "/v1/auth/device", {
      ...options,
      method: "POST",
      body: { code: connection.code },
    });
    if (!session.token) throw new Error("MILA did not create a dashboard session");
    sessionToken = session.token;
    dashboardSessions.set(cacheKey, sessionToken);
  }

  let voice;
  try {
    voice = await milaSessionRequest(cfg, "/v1/voice/token", {
      ...options,
      method: "POST",
      bearer: sessionToken,
      body: { language: options.language || "auto" },
    });
  } catch (error) {
    // Re-authorize once when the MILA backend revoked or lost its session.
    if (!/session|unauthorized|401/i.test(error.message || "")) throw error;
    dashboardSessions.delete(cacheKey);
    return milaVoiceToken(cfg, label, options);
  }
  if (!voice.token) throw new Error("MILA did not create a Gemini Live token");
  return {
    token: voice.token,
    expiresAt: voice.expiresAt || null,
    newSessionExpiresAt: voice.newSessionExpiresAt || null,
  };
}

export async function milaLiveKitToken(cfg, label = "Agentic OS dashboard", options = {}) {
  const cacheKey = cleanBaseUrl(cfg.baseUrl);
  let sessionToken = dashboardSessions.get(cacheKey);
  if (!sessionToken) {
    const connection = await milaConnectionCode(cfg, label, options);
    if (!connection.code) throw new Error("MILA did not create a connection code");
    const session = await milaSessionRequest(cfg, "/v1/auth/device", {
      ...options,
      method: "POST",
      body: { code: connection.code },
    });
    if (!session.token) throw new Error("MILA did not create a dashboard session");
    sessionToken = session.token;
    dashboardSessions.set(cacheKey, sessionToken);
  }

  try {
    const voice = await milaSessionRequest(cfg, "/v1/voice/livekit-token", {
      ...options,
      method: "POST",
      bearer: sessionToken,
      body: { language: options.language || "auto" },
    });
    if (!voice.participant_token || !voice.server_url) throw new Error("MILA did not create a LiveKit voice room");
    return {
      serverUrl: voice.server_url,
      participantToken: voice.participant_token,
      roomName: voice.room_name || "",
      language: voice.language || options.language || "auto",
    };
  } catch (error) {
    if (!/session|unauthorized|401/i.test(error.message || "")) throw error;
    dashboardSessions.delete(cacheKey);
    return milaLiveKitToken(cfg, label, options);
  }
}
export const milaSetSubscription = (cfg, subscription, options) => milaRequest(cfg, "/admin/subscription", {
  ...options, method: "POST", body: subscription,
});
export const milaSetAppUpdate = (cfg, update, options) => milaRequest(cfg, "/admin/app/update", {
  ...options, method: "POST", body: update,
});
