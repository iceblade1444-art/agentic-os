// The Mini App: the console, opened inside Telegram.
//
// Two things live here. `GET /tg` serves the same single-page app everyone else
// gets, with the two changes a Telegram container needs — the framing headers
// that let it be embedded, and the WebApp script that gives it a Back button
// and the reader's own theme. `POST /api/auth/telegram` turns Telegram's signed
// initData into an ordinary session.
//
// Nothing about the account model changes. Telegram's signature proves who is
// asking; the link table — the same one that has always decided who the bot may
// write to — decides whether that person is anybody here. A valid signature for
// an account nobody linked is a stranger with a genuine passport, and gets 403.

import fs from "node:fs";
import path from "node:path";
import { Router } from "express";

import { config } from "../config.js";
import { capabilities, creatorUser, sessionCookie, userFromSession } from "../lib/auth.js";
import { sessions } from "../lib/sessions.js";
import { telegram } from "../lib/telegram.js";
import { localeFromTelegram, verifyInitData } from "../lib/telegram-initdata.js";
import { users } from "../lib/users.js";

const r = Router();

// Telegram serves this from its own origin and keeps it in step with the client
// build. A vendored copy would be a copy that goes stale against a container we
// do not control, so this is the one script the CSP admits from elsewhere — and
// only on this route.
const WEBAPP_SCRIPT = "https://telegram.org/js/telegram-web-app.js";

// Only where the container actually frames us. The mobile clients use a WebView,
// where this does not apply; Telegram Web is a real iframe on these origins.
const FRAME_ANCESTORS = "https://web.telegram.org https://telegram.org";

const MINI_APP_CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "connect-src 'self' https://api.openai.com https://api.anthropic.com wss://agent.milanapremium.uz wss://generativelanguage.googleapis.com",
  `script-src 'self' ${new URL(WEBAPP_SCRIPT).origin}`,
  "media-src 'self' blob:",
  "frame-src 'self'",
  "base-uri 'self'",
  `frame-ancestors ${FRAME_ANCESTORS}`,
].join("; ");

/**
 * The shell, with the bridge script injected.
 *
 * Injected rather than kept in index.html so the ordinary web app never carries
 * a third-party script tag it has no use for, and so there is still one shell.
 */
export function miniAppHtml(indexHtml, script = WEBAPP_SCRIPT) {
  if (!indexHtml.includes("</head>")) throw new Error("index.html has no </head> to inject into");
  return indexHtml
    .replace("<html", '<html data-surface="telegram"')
    .replace("</head>", `    <script src="${script}"></script>\n  </head>`);
}

export function mountMiniApp(app, options = {}) {
  const root = options.root || path.resolve(config.dataDir, "..");
  const indexPath = options.indexPath || path.join(root, "index.html");

  app.get(["/tg", "/tg/*"], (req, res) => {
    let html;
    try { html = miniAppHtml(fs.readFileSync(indexPath, "utf8")); } catch (error) {
      console.error(`[miniapp] ${error.message}`);
      return res.status(500).send("Mini App is unavailable");
    }
    // The global middleware sends X-Frame-Options: DENY and frame-ancestors
    // 'none' — correct everywhere else, and the reason an embedded surface
    // renders blank until it is given its own exemption.
    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy", MINI_APP_CSP);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(html);
  });
}

/**
 * Exchange signed initData for a session.
 *
 * Deliberately not mounted behind requireAuth: this is the thing that
 * authenticates. It is rate limited, it never says which of the two checks
 * failed in a way that distinguishes "wrong signature" from "not linked" to an
 * attacker beyond the status code, and it issues exactly the session a browser
 * login issues — no wider, no longer.
 */
export function telegramAuthHandler(deps = {}) {
  const bridge = deps.telegram || telegram;
  const sessionStore = deps.sessions || sessions;
  const userStore = deps.users || users;
  const creator = deps.creatorUser || creatorUser;
  // ?? not ||, so an explicit empty token means "no token" rather than
  // silently falling back to the bridge's.
  const token = deps.botToken ?? (() => bridge.token());

  return async (req, res) => {
    const botToken = typeof token === "function" ? token() : token;
    if (!botToken) return res.status(503).json({ error: "Telegram is not configured" });

    const check = verifyInitData(String(req.body?.initData || ""), botToken, deps.verifyOptions);
    if (!check.ok) return res.status(401).json({ error: "Could not verify this Telegram session", code: check.reason });

    // In a private chat the chat id is the user id, which is what makes the
    // bot link double as a Mini App credential — and why nothing here has to
    // accept an id from the request body.
    const accountId = bridge.accountForChat(check.user.id);
    if (!accountId) {
      return res.status(403).json({
        error: "This Telegram account is not linked to Agentic OS",
        code: "not_linked",
      });
    }
    const user = accountId === "creator" ? creator() : userStore.get(accountId);
    if (!user || user.disabledAt) {
      // The link outlived the account. Drop it rather than leave a dead man's
      // chat half-alive, exactly as the message path does.
      bridge.unlink(accountId);
      return res.status(403).json({ error: "This account is no longer active", code: "not_linked" });
    }

    const session = sessionStore.create(user.id, {
      kind: "web",
      label: `Telegram${check.user.username ? ` @${check.user.username}` : ""}`,
      expiresAt: Date.now() + 7 * 864e5,
    });
    if (deps.commitAuthGroups) {
      try { await deps.commitAuthGroups("sessions"); } catch (error) {
        sessionStore.revoke(user.id, session.id);
        return res.status(error.status || 503).json({ error: error.message });
      }
    }
    res.setHeader("Set-Cookie", sessionCookie(req, user, session.id));
    res.json({
      ok: true,
      user: userFromSession({ user }),
      capabilities: capabilities(user),
      locale: localeFromTelegram(check.user.languageCode),
    });
  };
}

export default r;
