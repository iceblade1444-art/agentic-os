// Design was assignable in the user store for weeks while the PostgreSQL CHECK
// constraint still listed only Admin/Member/Viewer, so every Design account
// broke replication instead of being rejected up front. These tests exist to
// keep the two definitions from drifting apart a second time.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { ASSIGNABLE_ROLES, ASSIGNABLE_ROLE_SET, rolesSentence, rolesSqlList } from "../server/lib/roles.js";

test("the canonical role list is the one the product documents", () => {
  assert.deepEqual(ASSIGNABLE_ROLES, ["Admin", "CEO", "Design", "Member", "Viewer"]);
  // Creator is assembled from the environment, never stored as an account row.
  assert.equal(ASSIGNABLE_ROLE_SET.has("Creator"), false);
});

test("the role list cannot be mutated by a caller", () => {
  assert.throws(() => ASSIGNABLE_ROLES.push("Owner"), TypeError);
});

test("the SQL rendering quotes every role for the CHECK constraint", () => {
  assert.equal(rolesSqlList(), "'Admin', 'CEO', 'Design', 'Member', 'Viewer'");
});

test("the rejection message lists exactly what is accepted", () => {
  assert.equal(rolesSentence(), "Admin, CEO, Design, Member, or Viewer");
});

test("the database schema derives its roles from the canonical list", () => {
  const schema = fs.readFileSync(new URL("../server/lib/postgres-migration.js", import.meta.url), "utf8");

  // The constraint must be generated, not spelled out: a literal list here is
  // exactly the drift this module was created to end.
  assert.match(schema, /CHECK \(role IN \(\$\{rolesSqlList\(\)\}\)\)/);
  assert.doesNotMatch(schema, /CHECK \(role IN \('Admin'/);

  // CREATE TABLE IF NOT EXISTS never revisits a table that already exists, so
  // adding a role only fixes fresh databases unless the constraint is re-asserted.
  assert.match(schema, /ALTER TABLE \$\{SCHEMA\}\.users DROP CONSTRAINT IF EXISTS users_role_check/);
  assert.match(schema, /ADD CONSTRAINT users_role_check CHECK \(role IN \(\$\{rolesSqlList\(\)\}\)\)/);
});

test("the user store validates against the canonical list", () => {
  const users = fs.readFileSync(new URL("../server/lib/users.js", import.meta.url), "utf8");
  assert.match(users, /ASSIGNABLE_ROLE_SET/);
  assert.doesNotMatch(users, /new Set\(\["Admin"/);
  // The message is generated too, so it cannot promise a role the set refuses.
  assert.doesNotMatch(users, /Role must be Admin, CEO, Design, Member, or Viewer/);
});
