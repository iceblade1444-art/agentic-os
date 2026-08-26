// The factory on the stage (Ф7). What these defend: the stage and the ERP
// page read the same digest so they can never disagree, the heavy snapshot is
// cached instead of hammering eight live MCP tools on every vitals poll, and
// the panel's three states — unreachable, unconfigured, numbers — stay honest.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { erpDigest } from "../assets/js/pages/erp.js";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const COMMAND = read("assets/js/pages/command.js");

test("the digest turns a real-shaped snapshot into the numbers both surfaces show", () => {
  const digest = erpDigest({
    configured: true,
    cards: {
      erp_active_production: { data: { sewing_output: 320, packaging_output: 180, items: [{ id: 1 }, { id: 2 }] } },
      erp_finished_goods_stock: { data: { total_pieces: 4820, total_packages: 96 } },
      erp_late_orders: { data: { items: [{ id: "late-1" }] } },
    },
  });
  assert.equal(digest.productionOutput, 500, "staged outputs sum when no total is given");
  assert.equal(digest.readyPieces, 4820);
  assert.equal(digest.lateOrders, 1);
  assert.equal(digest.activeOrders, 2, "active orders fall back to counting production items");
});

test("an empty snapshot digests to zeros, not crashes", () => {
  const digest = erpDigest({});
  assert.equal(digest.productionOutput, 0);
  assert.equal(digest.readyPieces, 0);
  assert.deepEqual(digest.lateItems, []);
});

test("the stage reads the same digest as the ERP page", () => {
  assert.match(COMMAND, /import \{ erpDigest \} from "\.\/erp\.js"/);
  const erpPage = read("assets/js/pages/erp.js");
  assert.match(erpPage, /\} = erpDigest\(snapshot\);/, "the page itself must consume its own digest");
});

test("the snapshot is cached — eight live MCP tools must not ride the 45-second poll", () => {
  assert.match(COMMAND, /const ERP_TTL = 3 \* 60 \* 1000/);
  assert.match(COMMAND, /cmdErp && Date\.now\(\) - cmdErp\.at < ERP_TTL \? Promise\.resolve\(cmdErp\.data\)/);
});

test("the factory panel states are distinct and the voice is one tap away", () => {
  // unreachable, unconfigured and numbers are three different truths…
  assert.match(COMMAND, /!snapshot \? `<div class="cmd-empty">\$\{t\("dash\.svc\.unreachable"\)\}/);
  assert.match(COMMAND, /!snapshot\.configured \? `<div class="cmd-empty">\$\{t\("erp\.tokenMissing"\)\}/);
  // …and MILA's orb sits on the stage with her name on it.
  assert.match(COMMAND, /class="cmd-orb" href="#\/mila" aria-label="\$\{t\("nav\.mila"\)\}"/);
});
