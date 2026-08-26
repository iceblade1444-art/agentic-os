// Sheets: the day's operations without leaving the stage. What these defend:
// the approval id round-trip between needs-you and the pulse API, and the
// invariants that make an overlay livable — the poll never rebuilds the stage
// under an open sheet, closing restores the URL, unmount tears the sheet down.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { approvalIdOf } from "../assets/js/pages/command.js";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const COMMAND = read("assets/js/pages/command.js");

test("the approval id survives the needs-you round trip", () => {
  // needs-you prefixes approval ids; deciding one has to hand pulse the bare id.
  assert.match(read("server/lib/needs-you.js"), /id: `apr_\$\{clean\(approval\.id, 80\)\}`/,
    "the apr_ prefix moved — approvalIdOf must move with it");
  assert.equal(approvalIdOf({ id: "apr_abc123" }), "abc123");
  assert.equal(approvalIdOf({ id: "no-prefix" }), "no-prefix");
  assert.equal(approvalIdOf({}), "");
});

test("a poll never rebuilds the stage under an open sheet", () => {
  assert.match(COMMAND, /querySelector\("#cmdFilter:not\(\[hidden\]\), \.cmd-sheet"\)/,
    "the rerender guard must cover sheets, or the operator's place vanishes mid-thought");
});

test("sheets are deep-linkable and clean up after themselves", () => {
  // Opening writes the sheet's address without rebuilding the stage…
  assert.match(COMMAND, /history\.replaceState\(null, "", `#\/command\/sheet\/\$\{name\}/);
  // …closing restores the base address…
  assert.match(COMMAND, /if \(location\.hash\.startsWith\("#\/command\/sheet"\)\) history\.replaceState\(null, "", base\)/);
  // …arriving by the address opens the sheet…
  assert.match(COMMAND, /if \(parts\[0\] === "sheet" && parts\[1\]\) openSheetByName\(root, parts\[1\], parts\.slice\(2\)\.join\("\/"\)\)/);
  // …and leaving the page cannot strand one.
  assert.match(COMMAND, /sheetClose\?\.\(\);\s*\n\s*\},\s*\n\};/, "unmount must tear the open sheet down");
});

test("a sheet is a dialog a keyboard can live in", () => {
  assert.match(COMMAND, /panel\.setAttribute\("role", "dialog"\)/);
  assert.match(COMMAND, /panel\.setAttribute\("aria-modal", "true"\)/);
  assert.match(COMMAND, /if \(event\.key !== "Tab"\) return;/, "the focus trap went missing");
});

test("appending to a note sends the field the server actually reads", () => {
  // The route reads req.body.text — a {content} payload would 400 and the
  // note sheet's whole point is that writing works.
  assert.match(COMMAND, /api\.knowledge\.append\(\{ path, text \}\)/);
  assert.match(read("server/routes/knowledge.js"), /const \{ path, text \} = req\.body/);
});
