import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import pg from "pg";

const { Pool } = pg;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const SCHEMA = "agentic_os_shadow";

const empty = {
  users: [],
  sessions: [],
  tasks: [],
  notes: [],
  chatMessages: [],
  inboxItems: [],
  onboardingProfiles: [],
  workspaceContexts: [],
  mfaRecords: [],
  accountTokens: [],
};

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const stat = fs.statSync(file);
  if (stat.size > MAX_SOURCE_BYTES) {
    throw new Error(`Migration source exceeds ${MAX_SOURCE_BYTES} bytes: ${path.basename(file)}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function workspaceFile(baseDir, userId) {
  const key = crypto.createHash("sha256").update(String(userId)).digest("hex");
  return path.join(baseDir, "member-workspaces", `${key}.json`);
}

function unique(values) {
  return [...new Set(values.map(String).filter(Boolean))];
}

function sourceHash(rows) {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function migrationCounts(rows) {
  return Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value.length]));
}

export function buildPostgresMigrationPlan(dataDir) {
  const root = path.resolve(dataDir);
  const usersDocument = readJson(path.join(root, "users.json"), { users: [] });
  const sessionsDocument = readJson(path.join(root, "sessions.json"), { sessions: [] });
  const onboardingDocument = readJson(path.join(root, "onboarding.json"), { workspace: {}, users: {} });
  const mfaDocument = readJson(path.join(root, "mfa.json"), { records: {} });
  const tokenDocument = readJson(path.join(root, "account-tokens.json"), { tokens: [] });

  const rows = structuredClone(empty);
  rows.users = Array.isArray(usersDocument.users) ? usersDocument.users : [];
  rows.sessions = Array.isArray(sessionsDocument.sessions) ? sessionsDocument.sessions : [];
  rows.onboardingProfiles = Object.entries(onboardingDocument.users || {})
    .map(([userId, profile]) => ({ userId, profile }));
  if (onboardingDocument.workspace && Object.keys(onboardingDocument.workspace).length) {
    rows.workspaceContexts.push({ workspaceId: "default", payload: onboardingDocument.workspace });
  }
  rows.mfaRecords = Object.entries(mfaDocument.records || {})
    .map(([userId, record]) => ({ userId, record }));
  rows.accountTokens = Array.isArray(tokenDocument.tokens) ? tokenDocument.tokens : [];

  const userIds = unique([
    "creator",
    ...rows.users.map((item) => item.id),
    ...rows.sessions.map((item) => item.userId),
    ...rows.onboardingProfiles.map((item) => item.userId),
    ...rows.mfaRecords.map((item) => item.userId),
    ...rows.accountTokens.map((item) => item.userId),
  ]);
  const matchedFiles = new Set();
  for (const userId of userIds) {
    const file = workspaceFile(root, userId);
    if (!fs.existsSync(file)) continue;
    matchedFiles.add(path.resolve(file));
    const workspace = readJson(file, { tasks: [], notes: [], chatMessages: [], inboxItems: [] });
    for (const task of Array.isArray(workspace.tasks) ? workspace.tasks : []) {
      rows.tasks.push({ ...task, userId });
    }
    for (const note of Array.isArray(workspace.notes) ? workspace.notes : []) {
      rows.notes.push({ ...note, userId });
    }
    for (const message of Array.isArray(workspace.chatMessages) ? workspace.chatMessages : []) {
      rows.chatMessages.push({ ...message, userId });
    }
    for (const item of Array.isArray(workspace.inboxItems) ? workspace.inboxItems : []) {
      rows.inboxItems.push({ ...item, userId });
    }
  }

  const workspaceDir = path.join(root, "member-workspaces");
  const orphanWorkspaceFiles = fs.existsSync(workspaceDir)
    ? fs.readdirSync(workspaceDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.resolve(workspaceDir, name))
      .filter((file) => !matchedFiles.has(file))
      .map((file) => path.basename(file))
    : [];

  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    rows,
    counts: migrationCounts(rows),
    sourceHash: sourceHash(rows),
    orphanWorkspaceFiles,
  };
}

const schemaSql = `
  CREATE SCHEMA IF NOT EXISTS ${SCHEMA};

  CREATE TABLE IF NOT EXISTS ${SCHEMA}.users (
    id text PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL UNIQUE,
    role text NOT NULL CHECK (role IN ('Admin', 'Member', 'Viewer')),
    avatar text NOT NULL DEFAULT '',
    disabled boolean NOT NULL DEFAULT false,
    salt text NOT NULL,
    password_hash text NOT NULL,
    session_version integer NOT NULL DEFAULT 1,
    email_verified_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    payload jsonb NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ${SCHEMA}.sessions (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('web', 'mobile')),
    label text NOT NULL,
    created_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    payload jsonb NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shadow_sessions_user_id_idx ON ${SCHEMA}.sessions(user_id);

  CREATE TABLE IF NOT EXISTS ${SCHEMA}.member_tasks (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    title text NOT NULL,
    detail text NOT NULL DEFAULT '',
    status text NOT NULL CHECK (status IN ('todo', 'doing', 'done')),
    priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
    due_date date,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    payload jsonb NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shadow_member_tasks_user_id_idx ON ${SCHEMA}.member_tasks(user_id);

  CREATE TABLE IF NOT EXISTS ${SCHEMA}.member_notes (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    title text NOT NULL,
    content text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    payload jsonb NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shadow_member_notes_user_id_idx ON ${SCHEMA}.member_notes(user_id);

  CREATE TABLE IF NOT EXISTS ${SCHEMA}.member_chat_messages (
    id text NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    source text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS shadow_member_chat_user_created_idx
    ON ${SCHEMA}.member_chat_messages(user_id, created_at);

  CREATE TABLE IF NOT EXISTS ${SCHEMA}.member_inbox_items (
    id text NOT NULL,
    user_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('unread', 'read', 'archived')),
    type text NOT NULL,
    priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS shadow_member_inbox_user_status_idx
    ON ${SCHEMA}.member_inbox_items(user_id, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS ${SCHEMA}.onboarding_profiles (
    user_id text PRIMARY KEY,
    payload jsonb NOT NULL,
    updated_at timestamptz
  );

  CREATE TABLE IF NOT EXISTS ${SCHEMA}.workspace_contexts (
    workspace_id text PRIMARY KEY,
    payload jsonb NOT NULL,
    updated_at timestamptz
  );

  CREATE TABLE IF NOT EXISTS ${SCHEMA}.mfa_records (
    user_id text PRIMARY KEY,
    payload jsonb NOT NULL,
    enabled_at timestamptz
  );

  CREATE TABLE IF NOT EXISTS ${SCHEMA}.account_tokens (
    digest text PRIMARY KEY,
    user_id text NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    payload jsonb NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ${SCHEMA}.migration_runs (
    id bigserial PRIMARY KEY,
    source_hash text NOT NULL,
    source_counts jsonb NOT NULL,
    orphan_workspace_files jsonb NOT NULL,
    migrated_at timestamptz NOT NULL DEFAULT now()
  );
`;

const tableByCount = {
  users: "users",
  sessions: "sessions",
  tasks: "member_tasks",
  notes: "member_notes",
  chatMessages: "member_chat_messages",
  inboxItems: "member_inbox_items",
  onboardingProfiles: "onboarding_profiles",
  workspaceContexts: "workspace_contexts",
  mfaRecords: "mfa_records",
  accountTokens: "account_tokens",
};

async function insertRows(client, plan) {
  for (const user of plan.rows.users) {
    await client.query(
      `INSERT INTO ${SCHEMA}.users
       (id,name,email,role,avatar,disabled,salt,password_hash,session_version,email_verified_at,created_at,updated_at,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [user.id, user.name, user.email, user.role, user.avatar || "", !!user.disabled, user.salt,
        user.passwordHash, Number(user.sessionVersion) || 1, user.emailVerifiedAt || null,
        user.createdAt, user.updatedAt, user],
    );
  }
  for (const session of plan.rows.sessions) {
    await client.query(
      `INSERT INTO ${SCHEMA}.sessions
       (id,user_id,kind,label,created_at,last_seen_at,expires_at,revoked_at,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [session.id, session.userId, session.kind, session.label, session.createdAt,
        session.lastSeenAt, session.expiresAt, session.revokedAt || null, session],
    );
  }
  for (const task of plan.rows.tasks) {
    await client.query(
      `INSERT INTO ${SCHEMA}.member_tasks
       (id,user_id,title,detail,status,priority,due_date,created_at,updated_at,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [task.id, task.userId, task.title, task.detail || "", task.status, task.priority,
        task.dueDate || null, task.createdAt, task.updatedAt, task],
    );
  }
  for (const note of plan.rows.notes) {
    await client.query(
      `INSERT INTO ${SCHEMA}.member_notes
       (id,user_id,title,content,created_at,updated_at,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [note.id, note.userId, note.title, note.content || "", note.createdAt, note.updatedAt, note],
    );
  }
  for (const message of plan.rows.chatMessages) {
    await client.query(
      `INSERT INTO ${SCHEMA}.member_chat_messages
       (id,user_id,role,source,created_at,updated_at,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [message.id, message.userId, message.role, message.source || "mobile",
        message.createdAt, message.updatedAt || message.createdAt, message],
    );
  }
  for (const item of plan.rows.inboxItems) {
    await client.query(
      `INSERT INTO ${SCHEMA}.member_inbox_items
       (id,user_id,status,type,priority,created_at,updated_at,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [item.id, item.userId, item.status || "unread", item.type || "message",
        item.priority || "normal", item.createdAt, item.updatedAt || item.createdAt, item],
    );
  }
  for (const item of plan.rows.onboardingProfiles) {
    await client.query(
      `INSERT INTO ${SCHEMA}.onboarding_profiles (user_id,payload,updated_at) VALUES ($1,$2,$3)`,
      [item.userId, item.profile, item.profile.updatedAt || null],
    );
  }
  for (const item of plan.rows.workspaceContexts) {
    await client.query(
      `INSERT INTO ${SCHEMA}.workspace_contexts (workspace_id,payload,updated_at) VALUES ($1,$2,$3)`,
      [item.workspaceId, item.payload, item.payload.updatedAt || null],
    );
  }
  for (const item of plan.rows.mfaRecords) {
    await client.query(
      `INSERT INTO ${SCHEMA}.mfa_records (user_id,payload,enabled_at) VALUES ($1,$2,$3)`,
      [item.userId, item.record, item.record.enabledAt || null],
    );
  }
  for (const token of plan.rows.accountTokens) {
    await client.query(
      `INSERT INTO ${SCHEMA}.account_tokens
       (digest,user_id,purpose,created_at,expires_at,payload) VALUES ($1,$2,$3,$4,$5,$6)`,
      [token.digest, token.userId, token.purpose, token.createdAt, token.expiresAt, token],
    );
  }
}

export async function postgresShadowCounts(client) {
  const counts = {};
  for (const [key, table] of Object.entries(tableByCount)) {
    const result = await client.query(`SELECT count(*)::integer AS count FROM ${SCHEMA}.${table}`);
    counts[key] = result.rows[0].count;
  }
  return counts;
}

export function parityReport(sourceCounts, databaseCounts, orphanWorkspaceFiles = []) {
  const mismatches = Object.keys(sourceCounts)
    .filter((key) => sourceCounts[key] !== databaseCounts[key])
    .map((key) => ({ key, source: sourceCounts[key], database: databaseCounts[key] }));
  return {
    ok: mismatches.length === 0 && orphanWorkspaceFiles.length === 0,
    sourceCounts,
    databaseCounts,
    mismatches,
    orphanWorkspaceFiles,
  };
}

export async function migratePostgresShadow({
  dataDir,
  databaseUrl,
  pool,
} = {}) {
  const plan = buildPostgresMigrationPlan(dataDir);
  const ownedPool = pool || new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
  });
  const client = await ownedPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [1447145031]);
    await client.query(schemaSql);
    await client.query(`
      TRUNCATE
        ${SCHEMA}.account_tokens,
        ${SCHEMA}.mfa_records,
        ${SCHEMA}.workspace_contexts,
        ${SCHEMA}.onboarding_profiles,
        ${SCHEMA}.member_inbox_items,
        ${SCHEMA}.member_chat_messages,
        ${SCHEMA}.member_notes,
        ${SCHEMA}.member_tasks,
        ${SCHEMA}.sessions,
        ${SCHEMA}.users
    `);
    await insertRows(client, plan);
    const databaseCounts = await postgresShadowCounts(client);
    const report = parityReport(plan.counts, databaseCounts, plan.orphanWorkspaceFiles);
    if (!report.ok) throw new Error(`PostgreSQL parity check failed: ${JSON.stringify(report)}`);
    await client.query(
      `INSERT INTO ${SCHEMA}.migration_runs
       (source_hash,source_counts,orphan_workspace_files) VALUES ($1,$2,$3)`,
      [plan.sourceHash, plan.counts, plan.orphanWorkspaceFiles],
    );
    await client.query("COMMIT");
    return { ...report, sourceHash: plan.sourceHash, schema: SCHEMA };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    if (!pool) await ownedPool.end();
  }
}

export async function verifyPostgresShadow({
  dataDir,
  databaseUrl,
  pool,
} = {}) {
  const plan = buildPostgresMigrationPlan(dataDir);
  const ownedPool = pool || new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
  });
  const client = await ownedPool.connect();
  try {
    const databaseCounts = await postgresShadowCounts(client);
    return {
      ...parityReport(plan.counts, databaseCounts, plan.orphanWorkspaceFiles),
      sourceHash: plan.sourceHash,
      schema: SCHEMA,
    };
  } finally {
    client.release();
    if (!pool) await ownedPool.end();
  }
}

