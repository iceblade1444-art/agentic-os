// The Second Brain's domains come from the vault's real folders. What these
// defend: the grouping survives the vault's actual shape — nearly everything
// nested under one container folder — and the picture never lies about
// proportions by silently dropping notes.
import assert from "node:assert/strict";
import test from "node:test";

import { domainsFrom } from "../assets/js/pages/command.js";

const note = (folder, name = "note") => ({ id: `${folder}/${name}.md`, label: name, folder });

test("plain top-level folders become domains, largest first", () => {
  const domains = domainsFrom([
    note("Business"), note("Business"), note("Business"),
    note("Content"), note("Content"),
    note("Personal"),
  ]);
  assert.deepEqual(domains.map((domain) => [domain.name, domain.count]),
    [["Business", 3], ["Content", 2], ["Personal", 1]]);
  assert.ok(domains.every((domain) => domain.color && domain.slug));
});

test("a dominant container folder is opened up, not shown as one blob", () => {
  // The real vault: 18 of 20 notes under "Agentic OS/<something>".
  const nodes = [
    ...Array.from({ length: 9 }, (_, i) => note("Agentic OS/Journal", `j${i}`)),
    ...Array.from({ length: 7 }, (_, i) => note("Agentic OS/Marketing", `m${i}`)),
    ...Array.from({ length: 2 }, (_, i) => ({ id: `Agentic OS/r${i}.md`, label: `r${i}`, folder: "Agentic OS" })),
    note("Projects"),
    { id: "loose.md", label: "loose", folder: "Vault root" },
  ];
  const domains = domainsFrom(nodes);
  const names = domains.map((domain) => domain.name);
  assert.ok(names.includes("Journal"), `expected the container's subfolders as domains, got ${names}`);
  assert.ok(names.includes("Marketing"));
  assert.ok(!names.includes("Agentic OS") || domains.find((d) => d.name === "Agentic OS").count === 2,
    "the container itself may only keep its own loose notes");
  const total = domains.reduce((sum, domain) => sum + domain.count, 0);
  assert.equal(total, nodes.length, "every note is seated somewhere");
});

test("beyond the display limit, the rest is an honest bucket, not a silent drop", () => {
  const nodes = Array.from({ length: 9 }, (_, i) =>
    Array.from({ length: 9 - i }, (_, j) => note(`Folder${i}`, `n${j}`))).flat();
  const domains = domainsFrom(nodes);
  assert.ok(domains.length <= 7, "six named domains plus the bucket");
  const total = domains.reduce((sum, domain) => sum + domain.count, 0);
  assert.equal(total, nodes.length);
});

test("an empty vault yields no domains and no crash", () => {
  assert.deepEqual(domainsFrom([]), []);
  assert.deepEqual(domainsFrom(), []);
});
