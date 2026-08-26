// Database migration health, formerly part of the Operational Home and now
// read by the Command Center's Systems sheet. The JSON-to-Postgres migration
// runs live behind a consistency gate that falls back to JSON on its own.
// Falling back is normal and by design; what is not normal is an outbox that
// keeps growing or a refresh that keeps failing.
const OUTBOX_WARN = 25;
const OUTBOX_FAIL = 200;

// Returns codes and numbers rather than prose, so the page decides the wording
// in the reader's language and the rules stay testable on their own.
export function databaseHealth(database = {}) {
  const outbox = database.outbox || {};
  const pending = Number(outbox.pending) || 0;
  const failures = Number(database.consecutiveFailures) || 0;
  const refreshFailures = Number(database.authReads?.refreshFailures) || 0;
  const error = [database.error, outbox.error, database.reads?.error, database.writes?.error,
    database.authReads?.error, database.authWrites?.error].filter(Boolean)[0] || "";

  const base = {
    pending, failures, refreshFailures, error,
    status: database.status || "",
    lastSuccessAt: database.lastSuccessAt || null,
    source: database.sourceOfTruth === "postgres" ? "postgres" : "hybrid",
    reasons: [],
  };
  if (!database.enabled) return { ...base, level: "off", source: "off" };

  const reasons = [];
  let level = "ok";
  const escalate = (next) => { level = level === "fail" ? "fail" : next; };
  if (error) { level = "fail"; reasons.push({ code: "error", value: String(error).slice(0, 120) }); }
  // A stale auth cache decides who can sign in, so it is never merely a warning.
  if (refreshFailures > 0) { level = "fail"; reasons.push({ code: "refreshFailures", value: refreshFailures }); }
  if (failures > 0) { escalate("warn"); reasons.push({ code: "syncFailures", value: failures }); }
  if (pending >= OUTBOX_FAIL) { level = "fail"; reasons.push({ code: "outbox", value: pending }); }
  else if (pending >= OUTBOX_WARN) { escalate("warn"); reasons.push({ code: "outbox", value: pending }); }
  if (database.status && database.status !== "ready" && level === "ok") {
    level = "warn";
    reasons.push({ code: "status", value: database.status });
  }
  return { ...base, level, reasons };
}
