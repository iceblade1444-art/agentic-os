import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { hardenRuntimeFile } from "./runtime-files.js";

const MAX_DEVICES_PER_USER = 10;
const clean = (value, max) => String(value || "").trim().slice(0, max);
const now = () => new Date().toISOString();

function emptyState() {
  return { version: 1, devices: [] };
}

function publicDevice(device = {}) {
  return {
    id: clean(device.id, 120) || `dev_${crypto.randomUUID()}`,
    userId: clean(device.userId, 120),
    token: clean(device.token, 4096),
    platform: ["android", "ios"].includes(device.platform) ? device.platform : "android",
    locale: clean(device.locale, 16) || "en",
    createdAt: clean(device.createdAt, 40) || now(),
    updatedAt: clean(device.updatedAt, 40) || now(),
  };
}

export class PushDeviceStore {
  constructor(file = path.join(path.resolve(config.dataDir), "push-devices.json")) {
    this.file = file;
  }

  read() {
    try {
      if (!fs.existsSync(this.file)) return emptyState();
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        version: 1,
        devices: Array.isArray(parsed.devices)
          ? parsed.devices.map(publicDevice).filter((device) => device.userId && device.token)
          : [],
      };
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Push device data is corrupted");
      throw error;
    }
  }

  write(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, devices: state.devices }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    hardenRuntimeFile(this.file, 0o600);
  }

  list(userId) {
    return this.read().devices.filter((device) => device.userId === userId);
  }

  register(userId, input = {}) {
    const token = clean(input.token, 4096);
    if (token.length < 20) {
      const error = new Error("A valid push token is required");
      error.status = 400;
      throw error;
    }
    const timestamp = now();
    const state = this.read();
    // A Firebase token belongs to one installation and must never cross accounts.
    state.devices = state.devices.filter((device) => device.token !== token);
    const device = publicDevice({
      id: clean(input.deviceId, 120) || `dev_${crypto.randomUUID()}`,
      userId,
      token,
      platform: input.platform,
      locale: input.locale,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    state.devices = state.devices.filter(
      (entry) => !(entry.userId === userId && entry.id === device.id),
    );
    const own = state.devices.filter((entry) => entry.userId === userId);
    const others = state.devices.filter((entry) => entry.userId !== userId);
    state.devices = [...others, ...own.slice(-(MAX_DEVICES_PER_USER - 1)), device];
    this.write(state);
    return { id: device.id, platform: device.platform, locale: device.locale, updatedAt: device.updatedAt };
  }

  remove(userId, deviceId) {
    const state = this.read();
    const next = state.devices.filter(
      (device) => !(device.userId === userId && device.id === deviceId),
    );
    if (next.length === state.devices.length) return false;
    state.devices = next;
    this.write(state);
    return true;
  }

  removeTokens(tokens = []) {
    if (!tokens.length) return 0;
    const blocked = new Set(tokens);
    const state = this.read();
    const next = state.devices.filter((device) => !blocked.has(device.token));
    const removed = state.devices.length - next.length;
    if (removed) {
      state.devices = next;
      this.write(state);
    }
    return removed;
  }

  removeUser(userId) {
    const state = this.read();
    const next = state.devices.filter((device) => device.userId !== userId);
    if (next.length === state.devices.length) return false;
    state.devices = next;
    this.write(state);
    return true;
  }
}

export const pushDevices = new PushDeviceStore();
