import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { config } from "../config.js";
import { pushDevices } from "./push-devices.js";
import { telegram } from "./telegram.js";
import { activity, entryFromItem } from "./activity.js";
import { cardKindOf } from "./telegram-cards.js";

const oauthUrl = "https://oauth2.googleapis.com/token";
const messagingScope = "https://www.googleapis.com/auth/firebase.messaging";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

class PushService {
  constructor() {
    this.serviceAccount = null;
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
  }

  configured() {
    return !!(
      config.firebase.projectId
      && (config.firebase.serviceAccountFile || config.firebase.serviceAccountJson)
    );
  }

  credentials() {
    if (this.serviceAccount) return this.serviceAccount;
    let credentials = config.firebase.serviceAccountJson;
    if (!credentials && config.firebase.serviceAccountFile) {
      credentials = fs.readFileSync(path.resolve(config.firebase.serviceAccountFile), "utf8");
    }
    const parsed = JSON.parse(credentials || "{}");
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("Firebase service account is incomplete");
    }
    this.serviceAccount = parsed;
    return parsed;
  }

  async token() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60000) {
      return this.accessToken;
    }
    const serviceAccount = this.credentials();
    const issuedAt = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iss: serviceAccount.client_email,
      scope: messagingScope,
      aud: oauthUrl,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })}`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), {
      key: serviceAccount.private_key,
      encoding: "utf8",
    }).toString("base64url");
    const response = await fetch(oauthUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    const result = await response.json();
    if (!response.ok || !result.access_token) {
      throw new Error(`Firebase OAuth failed (${response.status})`);
    }
    this.accessToken = result.access_token;
    this.accessTokenExpiresAt = Date.now() + (Number(result.expires_in) || 3600) * 1000;
    return this.accessToken;
  }

  async sendDevice(device, item, accessToken) {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.firebase.projectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: device.token,
            notification: {
              title: item.title || "MILA",
              body: item.body || "You have a new message",
            },
            data: {
              type: "agentic_inbox",
              inboxId: item.id,
              route: item.route || "/chat",
            },
            android: {
              priority: item.priority === "high" ? "HIGH" : "NORMAL",
            },
            apns: { payload: { aps: { sound: "default" } } },
          },
        }),
      },
    );
    const result = await response.json().catch(() => ({}));
    const status = result?.error?.status || "";
    return {
      success: response.ok,
      invalid: status === "UNREGISTERED" || (response.status === 400 && status === "INVALID_ARGUMENT"),
    };
  }

  status(userId = "") {
    return {
      configured: this.configured(),
      devices: userId ? pushDevices.list(userId).length : 0,
    };
  }

  async sendInbox(userId, item) {
    // Telegram rides along with every notification: this is the one door all
    // of them leave through — reminders, the morning brief, messenger pushes —
    // so a user who linked their chat gets each of them there too. Best-effort
    // and first, because having no FCM devices used to end delivery entirely,
    // and a phone without the app is exactly who Telegram is for.
    // The whole item goes across, not a flattened string: Telegram renders it
    // as the kind of thing it is — a reminder, a calendar alert, an ERP
    // anomaly — and offers the verbs that kind supports. Whether it is also
    // read aloud is item.speak, decided by whoever composed it, since they are
    // holding the profile already.
    // The phone's feed is written here because this is the one place every
    // notification passes through, and it already knows whose it is. Recording
    // it adds no audience: the same item is on its way to that person now.
    // Never allowed to break delivery — a feed is worth less than a reminder.
    try {
      activity.append(userId, entryFromItem(userId, item, cardKindOf));
    } catch (error) {
      console.warn(`[activity] not recorded for ${userId}: ${error.message}`);
    }
    telegram.sendCard(userId, item)
      .catch((error) => console.warn(`[telegram] delivery failed for ${userId}: ${error.message}`));

    const devices = pushDevices.list(userId);
    if (!devices.length) return { attempted: 0, delivered: 0, configured: this.configured() };
    try {
      const accessToken = await this.token();
      const results = await Promise.all(
        devices.map((device) => this.sendDevice(device, item, accessToken)),
      );
      const invalid = devices
        .filter((_, index) => results[index].invalid)
        .map((device) => device.token);
      pushDevices.removeTokens(invalid);
      const delivered = results.filter((result) => result.success).length;
      return {
        attempted: devices.length,
        delivered,
        failed: devices.length - delivered,
        configured: true,
      };
    } catch (error) {
      console.error(`[push] delivery failed for user ${userId}: ${error.message}`);
      return { attempted: devices.length, delivered: 0, failed: devices.length, configured: true };
    }
  }
}

export const pushService = new PushService();
