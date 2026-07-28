import { config } from "../config.js";
import { accountMailer } from "./mailer.js";
import { accountTokens } from "./account-tokens.js";
import { sessions } from "./sessions.js";
import { users } from "./users.js";

const generic = {
  ok: true,
  message: "If the account exists, an email has been sent.",
};

function link(kind, token) {
  const url = new URL(config.publicUrl);
  url.searchParams.set(kind === "verify_email" ? "verify" : "reset", token);
  return url.toString();
}

export async function sendVerification(user) {
  const token = accountTokens.create(user.id, "verify_email", 24 * 60 * 60 * 1000);
  return accountMailer.sendLink({
    to: user.email,
    name: user.name,
    purpose: "verify_email",
    url: link("verify_email", token),
  });
}

export async function forgotPasswordHandler(req, res) {
  const user = users.findByEmail(req.body?.email);
  if (user && accountMailer.ready) {
    try {
      const token = accountTokens.create(user.id, "reset_password", 30 * 60 * 1000);
      await accountMailer.sendLink({
        to: user.email,
        name: user.name,
        purpose: "reset_password",
        url: link("reset_password", token),
      });
    } catch (error) {
      console.error("[account-recovery] reset delivery failed:", error.message);
    }
  }
  res.status(202).json(generic);
}

export async function resendVerificationHandler(req, res) {
  const user = users.findByEmail(req.body?.email);
  if (user && !user.emailVerified && accountMailer.ready) {
    try { await sendVerification(user); }
    catch (error) { console.error("[account-recovery] verification delivery failed:", error.message); }
  }
  res.status(202).json(generic);
}

export function verifyEmailHandler(req, res) {
  const userId = accountTokens.consume(req.body?.token, "verify_email");
  if (!userId) return res.status(400).json({ error: "This verification link is invalid or expired", code: "invalid_token" });
  const user = users.markEmailVerified(userId);
  if (!user) return res.status(400).json({ error: "This verification link is invalid or expired", code: "invalid_token" });
  res.json({ ok: true });
}

export function resetPasswordHandler(req, res) {
  const token = String(req.body?.token || "");
  const password = String(req.body?.password || "");
  if (password.length < 10 || password.length > 256) {
    return res.status(400).json({ error: "Password must contain between 10 and 256 characters", code: "weak_password" });
  }
  const userId = accountTokens.consume(token, "reset_password");
  if (!userId) return res.status(400).json({ error: "This reset link is invalid or expired", code: "invalid_token" });
  try {
    const user = users.setPassword(userId, password);
    if (!user) return res.status(400).json({ error: "This reset link is invalid or expired", code: "invalid_token" });
    sessions.removeUser(userId);
    accountTokens.removeUser(userId);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code });
  }
}

export function recoveryStatus() {
  return {
    required: config.emailVerificationRequired,
    deliveryReady: accountMailer.ready,
  };
}
