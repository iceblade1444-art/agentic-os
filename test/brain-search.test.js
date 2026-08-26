// Brain search: one query across everything the OS holds. What these defend:
// a dead source costs its own rows and never the answer, the reply always
// says which sources it heard from, and no source can stall the whole search.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { searchBrain } from "../server/lib/brain.js";

const rows = (type, titles) => titles.map((title) => ({ type, route: type, title, snippet: "", id: title }));
const source = (name, result) => ({ name, run: async () => result });

test("results from every source merge under one roof", async () => {
  const answer = await searchBrain("milana", [
    source("notes", rows("note", ["Milana wholesale playbook"])),
    source("tasks", rows("task", ["Ship Milana lookbook"])),
    source("chats", rows("chat", ["Milana factory sync"])),
  ]);
  assert.equal(answer.results.length, 3);
  assert.deepEqual(answer.sources.map((entry) => [entry.name, entry.ok, entry.count]),
    [["notes", true, 1], ["tasks", true, 1], ["chats", true, 1]]);
  assert.equal(answer.partial, false);
});

test("a dead source costs its rows, never the answer — and the reply says so", async () => {
  const answer = await searchBrain("orders", [
    source("notes", rows("note", ["Orders SOP"])),
    { name: "erp", run: async () => { throw new Error("ERP bridge offline"); } },
  ]);
  assert.equal(answer.results.length, 1);
  const erp = answer.sources.find((entry) => entry.name === "erp");
  assert.equal(erp.ok, false);
  assert.match(erp.error, /offline/);
  assert.equal(answer.partial, true, "a partial answer must admit it is partial");
});

test("a hanging source is cut off instead of stalling the search", async () => {
  const answer = await searchBrain("plan", [
    source("notes", rows("note", ["Plan of record"])),
    { name: "tasks", run: () => new Promise(() => {}) },
  ], { timeoutMs: 60 });
  assert.equal(answer.results.length, 1);
  const tasks = answer.sources.find((entry) => entry.name === "tasks");
  assert.equal(tasks.ok, false);
  assert.match(tasks.error, /timed out/);
});

test("one-character queries are refused, not broadcast to nine sources", async () => {
  await assert.rejects(() => searchBrain("m", []), (error) => error.status === 400);
});

test("a title that starts with the query outranks one that merely contains it", async () => {
  const answer = await searchBrain("invoice", [
    source("notes", rows("note", ["Monthly invoice recap", "Invoice reconciliation"])),
  ]);
  assert.equal(answer.results[0].title, "Invoice reconciliation");
});

test("per-source and total caps hold", async () => {
  const many = rows("note", Array.from({ length: 20 }, (_, i) => `Note ${i}`));
  const answer = await searchBrain("note", [source("notes", many)], { perSource: 4, limit: 3 });
  assert.equal(answer.sources[0].count, 4, "per-source cap");
  assert.equal(answer.results.length, 3, "total cap");
});

test("the door is wired: route mounted operator-only, client can knock, every result type has words", () => {
  const index = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  assert.match(index, /app\.use\("\/api\/brain", requireOperator, brain\)/);
  const apiJs = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  assert.match(apiJs, /\/api\/brain\/search\?q=/);
  // Every type the federation can emit has a group label in the interface.
  const brainLib = fs.readFileSync(new URL("../server/lib/brain.js", import.meta.url), "utf8");
  const i18n = fs.readFileSync(new URL("../assets/js/i18n.js", import.meta.url), "utf8");
  const types = new Set([...brainLib.matchAll(/hit\("([a-z]+)"/g)].map((match) => match[1]));
  assert.ok(types.size >= 8, `expected the federation to emit many types, saw ${types.size}`);
  for (const type of types) {
    const count = [...i18n.matchAll(new RegExp(`"cmd\\.type\\.${type}":`, "g"))].length;
    assert.equal(count, 3, `cmd.type.${type} must exist in all three languages`);
  }
});
