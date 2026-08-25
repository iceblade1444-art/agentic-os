// The model catalogue reaching MILA.
//
// The ERP holds roughly 6,600 garment models behind /models, and until now the
// only thing the assistant knew about them was a count of how many were sitting
// in the finished-goods warehouse. Asked "какие у нас туники", she had nothing.
//
// Two properties matter more than the plumbing. A tool the model is never told
// about is a tool that never gets used, so the declaration is checked as
// carefully as the dispatch. And because the catalogue is far larger than any
// answer, every payload has to carry whether it is complete — an answer built
// on the first 25 of 1,291 matches must never be phrased as the whole truth.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { MILA_MEMBER_TOOLS, MILA_TOOLS } from "../assets/js/mila-tools.js";
import { channelAllows } from "../server/lib/mila-audience.js";
import { OPERATOR_ERP_ACTIONS, READ_ONLY_ERP_ACTIONS } from "../server/lib/mila-actions.js";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const ACTIONS = read("server/lib/mila-actions.js");
const PY = read("vendor/milana-erp-mcp/src/milana_erp_mcp/tools.py");
const PY_SERVER = read("vendor/milana-erp-mcp/src/milana_erp_mcp/server.py");

const MODEL_ACTIONS = ["get_models_overview", "find_models", "get_model_details"];

test("the catalogue is readable by everyone who can ask", () => {
  // No personal data and no money: which garments the factory makes is what a
  // floor manager is asked all day.
  for (const name of MODEL_ACTIONS) {
    assert.ok(READ_ONLY_ERP_ACTIONS.has(name), `${name} is not a read-only ERP action`);
    assert.equal(OPERATOR_ERP_ACTIONS.has(name), false, `${name} must not be operator-only`);
  }
});

test("every door carries them, including voice", () => {
  const operator = { id: "creator", name: "Creator", role: "Creator" };
  const member = { id: "u1", name: "Шухрат", role: "Member" };
  for (const name of MODEL_ACTIONS) {
    for (const channel of ["app", "voice", "chat", "telegram"]) {
      assert.ok(channelAllows(name, operator, channel), `${name} blocked for operator on ${channel}`);
      assert.ok(channelAllows(name, member, channel), `${name} blocked for member on ${channel}`);
    }
  }
});

test("the model is told the tools exist, or it will never call them", () => {
  // The gate and the dispatch can both be perfect and the feature still be
  // invisible, because nothing offered it.
  for (const name of MODEL_ACTIONS) {
    const tool = MILA_TOOLS.find((item) => item.name === name);
    assert.ok(tool, `${name} is missing from MILA_TOOLS`);
    assert.ok(tool.description.length > 60, `${name} needs a description that says when to use it`);
    assert.ok(
      MILA_MEMBER_TOOLS.some((item) => item.name === name),
      `${name} is missing from the Member tool list`,
    );
  }
});

test("the descriptions carry the words a person actually says", () => {
  // Asked in Russian on a factory floor. A description written only in English
  // leaves the model guessing which tool "есть ли у нас туники" belongs to.
  const find = MILA_TOOLS.find((item) => item.name === "find_models");
  assert.match(find.description, /туник|модель|модел/i);
  const overview = MILA_TOOLS.find((item) => item.name === "get_models_overview");
  assert.match(overview.description, /сколько|модел/i);
  // And it must say what it is not, because the ERP has three different numbers
  // that all sound like "how much do we have".
  assert.match(overview.description, /not warehouse stock|not production output/i);
});

test("find_models takes a query, a status and a bound", () => {
  const tool = MILA_TOOLS.find((item) => item.name === "find_models");
  const props = tool.parameters.properties;
  assert.ok(props.query, "there is no way to say what to look for");
  assert.ok(props.status);
  assert.equal(props.limit.maximum, 100);
});

test("get_model_details accepts a code, which is how people refer to a model", () => {
  const tool = MILA_TOOLS.find((item) => item.name === "get_model_details");
  assert.ok(tool.parameters.properties.code);
  assert.ok(tool.parameters.properties.modelId);
  assert.match(tool.description, /TJ2211/, "an example code teaches the shape better than a sentence");
});

test("each action calls its own ERP tool, and only that", () => {
  const block = ACTIONS.slice(
    ACTIONS.indexOf('if (name === "get_models_overview"'),
    ACTIONS.indexOf('if (name === "get_erp_business_context"'),
  );
  assert.ok(block.length > 200, "the dispatch block moved");
  assert.match(block, /callTool\("erp_models_overview"\)/);
  assert.match(block, /callTool\("erp_model_search", \{/);
  assert.match(block, /callTool\("erp_model_details", \{/);
});

test("every answer says whether it is the whole answer", () => {
  // The catalogue is 6,600 models and 1,291 of them match "туник". Any payload
  // that could be partial has to say so, or MILA reports 25 as if it were all.
  const block = ACTIONS.slice(ACTIONS.indexOf('if (name === "get_models_overview"'));
  assert.match(block, /counted_completely:false means the walk was cut short/);
  assert.match(block, /showing_all_matches:false means more matched than are listed/);
  assert.match(block, /searched_whole_catalogue:false/);
  // And the fields those policies describe are actually produced.
  assert.match(PY, /"counted_completely": not truncated/);
  assert.match(PY, /"showing_all_matches": len\(found\) <= capped/);
  assert.match(PY, /"searched_whole_catalogue": not truncated/);
});

test("an incomplete catalogue record is named, not filled in", () => {
  // The details path is the fall-through of the block, not its own if.
  const block = ACTIONS.slice(ACTIONS.indexOf('callTool("erp_model_details"'));
  assert.match(block, /Empty sizes, colors or composition mean the catalogue record is incomplete/);
  assert.match(block, /rather than inferring from the name/);
});

test("cost never leaves the ERP through this door", () => {
  // The raw BOM carries default_cost and supplier SKUs on every line.
  assert.match(PY, /def _model_bom/);
  // Sliced past the docstring, which names default_cost in order to explain why
  // it is left out — matching the prose would pass on a function that returned
  // the whole line, and the first version of this test did exactly that.
  const whole = PY.slice(PY.indexOf("def _model_bom"), PY.indexOf("async def _walk_models"));
  const bom = whole.slice(whole.indexOf('"""', whole.indexOf('"""') + 3) + 3);
  assert.ok(bom.includes("rows.append"), "the docstring slice ate the body");
  assert.doesNotMatch(bom, /default_cost/);
  assert.doesNotMatch(bom, /"sku"/);
  assert.match(ACTIONS, /materials carries quantity per piece and no cost; for cost use the finance tool/);
});

test("the three tools are registered on the MCP server", () => {
  // Defined and not registered is the same as not existing.
  for (const name of ["erp_models_overview", "erp_model_search", "erp_model_details"]) {
    assert.match(PY_SERVER, new RegExp(`async def ${name}\\(`), `${name} is not registered`);
    assert.match(PY, new RegExp(`async def ${name}_tool\\(`), `${name}_tool is not defined`);
  }
});

test("the search parameters the ERP ignores are never sent", () => {
  // Sending them returns the unfiltered first page dressed up as a search
  // result — confidently wrong, which is worse than an error.
  const walk = PY.slice(PY.indexOf("async def _walk_models"), PY.indexOf("def _matches"));
  for (const ignored of ["\"search\"", "\"q\"", "\"season\"", "\"product_type\"", "\"name\""]) {
    assert.equal(walk.includes(ignored), false, `${ignored} is sent to an endpoint that ignores it`);
  }
  assert.match(walk, /params\["status"\] = status/, "status is a real filter and should be used");
});
