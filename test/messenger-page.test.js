import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../assets/js/pages/messenger.js", import.meta.url), "utf8");

test("the chat re-renders in place instead of asking the router to remount", () => {
  // The router's route() tears the page down and calls mount() again on every
  // hashchange. mount() loads the conversation, loading re-renders, and a
  // re-render that dispatched hashchange started the cycle over: an unbounded
  // request loop that ran the API into its 600/minute rate limit and left the
  // page showing "Chat is unavailable — rate limited".
  assert.equal(source.includes("HashChangeEvent"), false, "the chat must never dispatch a route change to redraw");
  assert.match(source, /function rerender\(\)/);
  assert.match(source, /root\.innerHTML = render\(\);\s*\n\s*wire\(root\);/);
});

test("a redraw keeps the draft, the caret and the scroll position", () => {
  // A remount also wiped the textarea and jumped the thread to the top. With an
  // incoming message redrawing the page, that meant losing what you were typing
  // whenever a colleague wrote.
  for (const needle of ["const draft = input ? input.value : null", "setSelectionRange", "stickToBottom", "previousScroll"]) {
    assert.ok(source.includes(needle), `${needle} must survive a redraw`);
  }
});

test("mount does not refetch a thread it already has", () => {
  assert.match(source, /if \(activeId && \(!messages\.length \|\| messages\[0\]\?\.conversationId !== activeId\)\)/);
});

test("bursts do not become bursts of requests", () => {
  // One read receipt per couple of seconds, one typing ping per few seconds.
  assert.match(source, /function markReadSoon/);
  assert.match(source, /Date\.now\(\) - markReadAt < 2000/);
  assert.match(source, /Date\.now\(\) - lastTypingSent < 3000/);
  assert.equal(source.includes("api.messenger.markRead(activeId).catch"), false, "every incoming message must not mark read");
});

test("the page never reaches outside its own mounted root", () => {
  // Reaching into document would find the previous page's nodes after a route
  // change and redraw into a detached tree.
  assert.equal(/document\.(getElementById|querySelector)\(/.test(source), false);
  assert.match(source, /if \(!root \|\| !root\.isConnected\) return;/);
});
