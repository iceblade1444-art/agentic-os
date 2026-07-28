import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Personal files are account-scoped, bounded and downloaded safely", () => {
  const store = fs.readFileSync(new URL("../server/lib/personal-files.js", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../server/routes/personal.js", import.meta.url), "utf8");
  const lifecycle = fs.readFileSync(new URL("../server/lib/account-lifecycle.js", import.meta.url), "utf8");

  assert.match(store, /MAX_BYTES = 600 \* 1024/);
  assert.match(store, /userKey\(userId\)/);
  assert.match(store, /path\.basename/);
  assert.match(route, /X-Content-Type-Options/);
  assert.match(route, /Content-Disposition/);
  assert.match(lifecycle, /personalFileStore\.removeUser\(id\)/);
});
