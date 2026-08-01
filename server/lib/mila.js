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
  ...options,
  method: "POST",
  body: {
    label,
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.accountGrant ? { accountGrant: options.accountGrant } : {}),
  },
});
export const milaDevices = (cfg, options) => milaRequest(cfg, "/admin/devices", options);
export const milaRevokeDevice = (cfg, id, options) => {
  if (!/^[a-f0-9]{32}$/.test(String(id || ""))) throw new Error("Invalid MILA device ID");
  return milaRequest(cfg, `/admin/devices/${id}`, { ...options, method: "DELETE" });
};

// One cached device session backs every MILA call the dashboard makes, so the
// admin token and the provider keys never reach the browser.
async function dashboardSession(cfg, label, options = {}) {
  const cacheKey = cleanBaseUrl(cfg.baseUrl);
  const cached = dashboardSessions.get(cacheKey);
  if (cached) return cached;
  if (/^Agentic OS dashboard$/i.test(label)) {
    const listed = await milaDevices(cfg, options).catch(() => ({ devices: [] }));
    const stale = (listed.devices || []).filter((device) =>
      device.active && device.label === label && /^[a-f0-9]{32}$/.test(device.id));
    await Promise.all(stale.map((device) =>
      milaRevokeDevice(cfg, device.id, options).catch(() => null)));
  }
  const connection = await milaConnectionCode(cfg, label, options);
  if (!connection.code) throw new Error("MILA did not create a connection code");
  const session = await milaSessionRequest(cfg, "/v1/auth/device", {
    ...options,
    method: "POST",
    body: { code: connection.code },
  });
  if (!session.token) throw new Error("MILA did not create a dashboard session");
  dashboardSessions.set(cacheKey, session.token);
  return session.token;
}

// Mint a constrained Gemini Live token without exposing MILA's admin token,
// account session, or long-lived provider key to the browser.
export async function milaVoiceToken(cfg, label = "Agentic OS dashboard", options = {}) {
  const cacheKey = cleanBaseUrl(cfg.baseUrl);
  const sessionToken = await dashboardSession(cfg, label, options);

  let voice;
  try {
    voice = await milaSessionRequest(cfg, "/v1/voice/token", {
      ...options,
      method: "POST",
      bearer: sessionToken,
      body: {
        language: options.language || "auto",
        ...(options.profile && typeof options.profile === "object" ? { profile: options.profile } : {}),
      },
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

// Written conversation goes through MILA's Gemini chat endpoint rather than the
// Live API: live models answer in audio only, and generateContent handles text
// plus inline images in one request.
export async function milaGeminiChat(cfg, label = "Agentic OS dashboard", options = {}) {
  const sessionToken = await dashboardSession(cfg, label, options);
  const body = {
    messages: Array.isArray(options.messages) ? options.messages.slice(-24) : [],
    ...(options.systemPrompt ? { systemPrompt: String(options.systemPrompt).slice(0, 30000) } : {}),
    ...(options.model ? { model: options.model } : {}),
  };
  if (!body.messages.length) throw Object.assign(new Error("A chat message is required"), { status: 400 });
  try {
    return await milaSessionRequest(cfg, "/v1/gemini/chat", {
      ...options, method: "POST", bearer: sessionToken, body, timeoutMs: options.timeoutMs || 60000,
    });
  } catch (error) {
    if (!/session|unauthorized|401/i.test(error.message || "")) throw error;
    dashboardSessions.delete(cleanBaseUrl(cfg.baseUrl));
    return milaGeminiChat(cfg, label, { ...options, retried: true });
  }
}

export async function milaLiveKitToken(cfg, label = "Agentic OS dashboard", options = {}) {
  const cacheKey = cleanBaseUrl(cfg.baseUrl);
  const sessionToken = await dashboardSession(cfg, label, options);

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
