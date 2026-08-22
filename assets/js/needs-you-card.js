// The queue of things blocked on a person, at the top of whatever they open.
//
// It is the first thing on the page because it is the only thing on the page
// that has stopped. Everything else — throughput, fleet state, sparklines —
// describes a system that is still moving; this describes one that is waiting.
//
// Mounted rather than rendered inline so the page it sits above does not have
// to know about it, and so a slow queue never delays the page. It inserts
// itself, fills in when the answer arrives, and removes itself when the answer
// is "nothing".

import { api } from "./api.js";
import { icon } from "./icons.js";
import { t } from "./i18n.js";
import { timeAgo } from "./store.js";
import { esc } from "./ui.js";

// Shape as well as colour, and a word as well as both: the factory floor reads
// this on a cheap phone in daylight, and one in twelve men cannot separate the
// red from the green.
const TONE = {
  blocked: { tone: "error", glyph: "!" },
  waiting: { tone: "warning", glyph: "?" },
  overdue: { tone: "warning", glyph: "!" },
  attention: { tone: "info", glyph: "↑" },
};

const age = (since) => {
  const at = Date.parse(since);
  return Number.isNaN(at) ? "" : timeAgo(at);
};

export function needsYouHTML(queue) {
  if (!queue || !queue.items.length) {
    return `<div class="needs needs-clear">
      <span class="needs-clear-mark">${icon("check")}</span>
      <div class="stack">
        <strong>${t("needs.empty")}</strong>
        <span class="cell-sub">${t("needs.emptyHint")}</span>
      </div>
    </div>`;
  }
  const oldest = queue.items[queue.items.length - 1];
  const rows = queue.items.slice(0, 6).map((item) => {
    const tone = TONE[item.severity] || TONE.attention;
    return `<a class="needs-row" href="#/${esc(item.route || "")}">
      <span class="needs-mark ${tone.tone}">${esc(tone.glyph)}</span>
      <span class="needs-text">
        <strong>${esc(item.title)}</strong>
        <span>${esc(t(`needs.kind.${item.kind}`))}${item.detail ? ` · ${esc(item.detail)}` : ""}${item.since ? ` · ${esc(age(item.since))}` : ""}</span>
      </span>
      <span class="needs-go">${t("needs.open")}</span>
    </a>`;
  }).join("");

  return `<div class="needs needs-${esc(queue.severity || "attention")}">
    <div class="needs-head">
      <strong>${t("needs.title")}</strong>
      <span class="needs-pill">${t("needs.count", {
        count: queue.total,
        oldest: t("needs.oldest", { age: age(oldest.since) || "—" }),
      })}</span>
    </div>
    ${rows}
  </div>`;
}

/**
 * Put the queue above `root`'s content and keep it current.
 *
 * Returns a teardown. A page that mounts this must call it on unmount, or the
 * refresh interval outlives the page and fetches for a screen nobody is on.
 */
export function mountNeedsYou(root, { intervalMs = 60000 } = {}) {
  if (!root || !api.on) return () => {};
  const host = document.createElement("div");
  host.className = "needs-host";
  root.prepend(host);

  let stopped = false;
  const draw = async () => {
    let queue = null;
    try { queue = await api.needsYou(); } catch { return; }
    if (stopped || !host.isConnected) return;
    host.innerHTML = needsYouHTML(queue);
  };
  draw();
  const timer = setInterval(draw, intervalMs);
  return () => { stopped = true; clearInterval(timer); host.remove(); };
}
