import { config } from "../server/config.js";
import {
  buildPostgresMigrationPlan,
  migratePostgresShadow,
  verifyPostgresShadow,
} from "../server/lib/postgres-migration.js";

const databaseUrl = process.env.DATABASE_URL || "";
const verifyOnly = process.argv.includes("--verify-only");
const dryRun = process.argv.includes("--dry-run");

if (dryRun) {
  const plan = buildPostgresMigrationPlan(config.dataDir);
  console.log(JSON.stringify({
    ok: plan.orphanWorkspaceFiles.length === 0,
    dryRun: true,
    schema: plan.schema,
    sourceHash: plan.sourceHash,
    counts: plan.counts,
    orphanWorkspaceFiles: plan.orphanWorkspaceFiles,
  }, null, 2));
  process.exit(plan.orphanWorkspaceFiles.length ? 1 : 0);
}

if (!databaseUrl) {
  console.error("DATABASE_URL is required for PostgreSQL migration");
  process.exit(2);
}

const result = verifyOnly
  ? await verifyPostgresShadow({ dataDir: config.dataDir, databaseUrl })
  : await migratePostgresShadow({ dataDir: config.dataDir, databaseUrl });

console.log(JSON.stringify({ ...result, verifyOnly }, null, 2));
process.exit(result.ok ? 0 : 1);

