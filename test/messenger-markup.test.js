// The messenger wires its handlers by attribute: render a string, then look the
// element up with querySelector("[data-x]"). Nothing connects the two, so a typo
// inside the attribute name is silent — the markup renders, the button appears,
// and the click handler is simply never attached.
//
// That is not hypothetical. `data-cancel-reply"` shipped with a stray quote. The
// HTML tokenizer treats `"` in an attribute name as a parse error but keeps it,
// so the element carried an attribute literally named `data-cancel-reply"` and
// the selector matched nothing. Once you tapped Reply, the quoted-message bar
// could not be dismissed at all, and the next message you sent silently became a
// reply to a message you thought you had cancelled.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../assets/js/pages/messenger.js", import.meta.url), "utf8");

// Names the page looks up, and names it actually writes into markup. An
// attribute is written either bare (`data-x>` / `data-x ` / `data-x=`) or with a
// value; anything else — a quote, a stray bracket — is a typo.
const queried = new Set(
  [...source.matchAll(/querySelector(?:All)?\(\s*"\[(data-[a-z-]+)\]"/g)].map((match) => match[1]),
);
const written = new Set(
  [...source.matchAll(/(?:^|[\s`])(data-[a-z-]+)(?=[\s=>])/gm)].map((match) => match[1]),
);

test("every attribute the page looks up is one it really renders", () => {
  assert.ok(queried.size > 15, "the extraction itself must still be finding selectors");
  for (const name of queried) {
    assert.ok(
      written.has(name),
      `querySelector("[${name}]") matches nothing: no element is rendered with that attribute, `
      + "so its handler is never attached and the control does nothing when clicked",
    );
  }
});

test("no attribute name carries a stray quote", () => {
  // The specific shape of the bug that shipped, in case the check above is ever
  // loosened: `class="icon-btn sm" data-cancel-reply">`.
  const broken = [...source.matchAll(/(data-[a-z-]+)"(?=[>\s])/g)]
    .map((match) => match[0])
    .filter((text) => !text.includes("="));
  assert.deepEqual(broken, [], "an attribute name ending in a quote is a typo, not a value");
});

test("the reply bar can be dismissed", () => {
  // The bar is only reachable through its cancel control: there is no Escape
  // binding and switching conversation is not a dismissal.
  assert.match(source, /class="chat-reply-bar"[\s\S]{0,400}?data-cancel-reply[\s>]/);
  assert.match(source, /\[data-cancel-reply\]"\)\?\.addEventListener\("click"/);
});
