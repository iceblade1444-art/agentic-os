import { mfa } from "../server/lib/mfa.js";

const userId = String(process.argv[2] || "").trim();
if (!/^(creator|usr_[a-zA-Z0-9-]{8,100})$/.test(userId)) {
  console.error("Usage: node scripts/mfa-reset.mjs <creator|usr_id>");
  process.exit(2);
}

const removed = mfa.removeUser(userId);
console.log(JSON.stringify({ ok: true, userId, removed }));
