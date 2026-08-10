import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";

// MILA plans the day, so she has to be able to put things in the calendar, not
// only read it. `calendar.events` covers create, move and delete on the user's own
// events; it does not include calendar management or sharing. Widening the scope
// invalidates existing grants: a user connected before this change keeps working
// read-only until they reconnect, which `status().scopeStale` surfaces.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
];
const READ_ONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const pending = new Map();
const file = path.join(config.dataDir, "google-workspace.json");
const key = crypto.createHash("sha256").update(`google-workspace:${config.sessionSecret}`).digest();
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_URL = "https://www.googleapis.com/calendar/v3";

function load() {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function save(value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((item) => item.toString("base64url")).join(".");
}

function decrypt(value) {
  const [iv, tag, body] = String(value || "").split(".").map((item) => Buffer.from(item, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString());
}

function configured() {
  return !!(config.googleWorkspace.clientId && config.googleWorkspace.clientSecret && config.googleWorkspace.redirectUri);
}

function grantedScopes(record) {
  const value = String(record?.scope || "").trim();
  // Grants written before scopes were recorded were read-only by construction.
  return value ? value.split(/\s+/) : (record ? [READ_ONLY_SCOPE] : []);
}

function publicStatus(userId) {
  const record = load()[userId];
  const granted = grantedScopes(record);
  const canWrite = granted.includes("https://www.googleapis.com/auth/calendar.events")
    || granted.includes("https://www.googleapis.com/auth/calendar");
  return {
    configured: configured(),
    connected: !!record,
    scopes: granted.map((scope) => scope.split("/").at(-1)),
    canWrite,
    // True when the grant predates calendar writes: reading still works, creating
    // an event does not, and the fix is to reconnect.
    scopeStale: !!record && !canWrite,
    connectedAt: record?.connectedAt || null,
  };
}

async function tokenRequest(body) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error_description || value.error || "Google OAuth failed"), { status: 502 });
  return value;
}

function saveToken(userId, token, connectedAt) {
  const records = load();
  records[userId] = {
    encrypted: encrypt(token),
    // A refresh response omits `scope`; keep whatever the original grant carried.
    scope: String(token.scope || records[userId]?.scope || "").trim(),
    connectedAt: connectedAt || records[userId]?.connectedAt || new Date().toISOString(),
  };
  save(records);
}

async function accessToken(userId, forceRefresh = false) {
  const records = load();
  const record = records[userId];
  if (!record) throw Object.assign(new Error("Google Calendar is not connected"), { status: 409 });

  const token = decrypt(record.encrypted);
  const expiresAt = Number(token.expires_at || 0);
  if (!forceRefresh && token.access_token && expiresAt > Date.now() + 60_000) {
    return token.access_token;
  }
  if (!token.refresh_token) {
    if (!forceRefresh && token.access_token) return token.access_token;
    throw Object.assign(new Error("Google authorization expired. Connect Calendar again."), { status: 401 });
  }

  const refreshed = await tokenRequest({
    client_id: config.googleWorkspace.clientId,
    client_secret: config.googleWorkspace.clientSecret,
    refresh_token: token.refresh_token,
    grant_type: "refresh_token",
  });
  const next = {
    ...token,
    ...refreshed,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + Math.max(60, Number(refreshed.expires_in || 3600)) * 1000,
  };
  saveToken(userId, next, record.connectedAt);
  return next.access_token;
}

async function calendarRequest(userId, pathAndQuery, { method = "GET", body } = {}) {
  const send = async (token) => fetch(`${GOOGLE_CALENDAR_URL}${pathAndQuery}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let token = await accessToken(userId);
  let response = await send(token);
  if (response.status === 401) {
    token = await accessToken(userId, true);
    response = await send(token);
  }
  if (response.status === 204) return {};
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = value?.error?.message || "Google Calendar request failed";
    throw Object.assign(new Error(message), { status: response.status === 403 ? 502 : response.status });
  }
  return value;
}

function requireWrite(userId) {
  const state = publicStatus(userId);
  if (!state.connected) throw Object.assign(new Error("Google Calendar is not connected"), { status: 409 });
  if (!state.canWrite) {
    throw Object.assign(
      new Error("Google Calendar is connected read-only. Reconnect it to let MILA create events."),
      { status: 403, code: "calendar_scope_stale" },
    );
  }
}

function eventPayload({ title, description, location, start, end, timeZone, allDay }) {
  const clean = (value, max) => String(value ?? "").trim().slice(0, max);
  const summary = clean(title, 300);
  if (!summary) throw Object.assign(new Error("Event title is required"), { status: 400 });
  const from = new Date(start);
  if (Number.isNaN(from.getTime())) throw Object.assign(new Error("Event start time is invalid"), { status: 400 });
  const to = end ? new Date(end) : new Date(from.getTime() + 60 * 60 * 1000);
  if (Number.isNaN(to.getTime()) || to <= from) {
    throw Object.assign(new Error("Event end time must be after the start time"), { status: 400 });
  }
  const zone = clean(timeZone, 80);
  const day = (date) => date.toISOString().slice(0, 10);
  return {
    summary,
    description: clean(description, 4000) || undefined,
    location: clean(location, 300) || undefined,
    start: allDay ? { date: day(from) } : { dateTime: from.toISOString(), ...(zone ? { timeZone: zone } : {}) },
    end: allDay ? { date: day(to) } : { dateTime: to.toISOString(), ...(zone ? { timeZone: zone } : {}) },
  };
}

function eventTime(value = {}) {
  return value.dateTime || value.date || null;
}

function normalizeEvent(value) {
  return {
    id: String(value.id || ""),
    title: String(value.summary || "Untitled event"),
    description: String(value.description || ""),
    location: String(value.location || ""),
    start: eventTime(value.start),
    end: eventTime(value.end),
    allDay: !!(value.start?.date && !value.start?.dateTime),
    status: String(value.status || "confirmed"),
    htmlLink: String(value.htmlLink || ""),
    calendarId: "primary",
  };
}

export const googleWorkspace = {
  status: (userId) => publicStatus(userId),

  connect(userId, { client = "web", locale = "en" } = {}) {
    if (!configured()) throw Object.assign(new Error("Google Workspace OAuth is not configured"), { status: 503 });
    const source = client === "mobile" ? "mobile" : "web";
    const language = ["ru", "uz"].includes(String(locale).slice(0, 2)) ? String(locale).slice(0, 2) : "en";
    const state = crypto.randomBytes(24).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    pending.set(state, { userId, verifier, client: source, locale: language, expiresAt: Date.now() + 10 * 60 * 1000 });
    const query = new URLSearchParams({
      client_id: config.googleWorkspace.clientId,
      redirect_uri: config.googleWorkspace.redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      scope: SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return { authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query}` };
  },

  async callback(code, state) {
    const request = pending.get(String(state || ""));
    pending.delete(String(state || ""));
    if (!request || request.expiresAt < Date.now()) {
      throw Object.assign(new Error("Google OAuth request is invalid or expired"), { status: 400 });
    }
    const token = await tokenRequest({
      code: String(code || ""),
      client_id: config.googleWorkspace.clientId,
      client_secret: config.googleWorkspace.clientSecret,
      redirect_uri: config.googleWorkspace.redirectUri,
      grant_type: "authorization_code",
      code_verifier: request.verifier,
    });
    saveToken(request.userId, {
      ...token,
      expires_at: Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000,
    });
    return {
      ...publicStatus(request.userId),
      client: request.client,
      locale: request.locale,
    };
  },

  async calendarEvents(userId, { from, to, limit = 20 } = {}) {
    const timeMin = new Date(from || Date.now());
    const timeMax = new Date(to || Date.now() + 30 * 24 * 60 * 60 * 1000);
    if (!Number.isFinite(timeMin.getTime()) || !Number.isFinite(timeMax.getTime()) || timeMax <= timeMin) {
      throw Object.assign(new Error("Calendar date range is invalid"), { status: 400 });
    }
    const maxResults = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const query = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: String(maxResults),
      singleEvents: "true",
      orderBy: "startTime",
    });
    const value = await calendarRequest(userId, `/calendars/primary/events?${query}`);
    return {
      events: Array.isArray(value.items)
        ? value.items.filter((item) => item.status !== "cancelled").map(normalizeEvent)
        : [],
      timeZone: String(value.timeZone || ""),
      syncedAt: new Date().toISOString(),
    };
  },

  async createEvent(userId, input = {}) {
    requireWrite(userId);
    const value = await calendarRequest(userId, "/calendars/primary/events", {
      method: "POST",
      body: eventPayload(input),
    });
    return { event: normalizeEvent(value) };
  },

  async updateEvent(userId, eventId, input = {}) {
    requireWrite(userId);
    const id = String(eventId || "").trim();
    if (!id) throw Object.assign(new Error("Event id is required"), { status: 400 });
    const current = await calendarRequest(userId, `/calendars/primary/events/${encodeURIComponent(id)}`);
    const merged = eventPayload({
      title: input.title ?? current.summary,
      description: input.description ?? current.description,
      location: input.location ?? current.location,
      start: input.start ?? eventTime(current.start),
      end: input.end ?? eventTime(current.end),
      timeZone: input.timeZone ?? current.start?.timeZone,
      allDay: input.allDay ?? !!(current.start?.date && !current.start?.dateTime),
    });
    const value = await calendarRequest(userId, `/calendars/primary/events/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: merged,
    });
    return { event: normalizeEvent(value) };
  },

  async deleteEvent(userId, eventId) {
    requireWrite(userId);
    const id = String(eventId || "").trim();
    if (!id) throw Object.assign(new Error("Event id is required"), { status: 400 });
    await calendarRequest(userId, `/calendars/primary/events/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { ok: true, id };
  },

  disconnect(userId) {
    const records = load();
    const record = records[userId];
    if (record) {
      try {
        const token = decrypt(record.encrypted);
        const revoke = token.refresh_token || token.access_token;
        if (revoke) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(revoke)}`, { method: "POST" }).catch(() => {});
      } catch {}
      delete records[userId];
      save(records);
    }
    return publicStatus(userId);
  },
};
