import { icon } from "./icons.js";
import { store } from "./store.js";

/* ---------- DOM helpers ---------- */
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
export const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- Agent visuals ---------- */
export function agentIcon(agent, size) {
  const style = `background:${store.colors[agent.color] || store.colors.violet};${size ? `width:${size}px;height:${size}px;` : ""}`;
  return `<div class="aico" style="${style}">${icon(agent.icon || "bot")}</div>`;
}
export function initials(name = "") {
  return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

/* ---------- Badges ---------- */
export function statusBadge(status) {
  const map = {
    active: ["success", "Active"], running: ["warning", "Running"], error: ["error", "Error"],
    completed: ["success", "Completed"], in_progress: ["info", "In Progress"], queued: ["neutral", "Queued"],
    idle: ["neutral", "Idle"], paused: ["warning", "Paused"], connected: ["success", "Connected"],
  };
  const [cls, label] = map[status] || ["neutral", status];
  return `<span class="badge ${cls}"><span class="dot"></span>${label}</span>`;
}

/* ---------- Toasts ---------- */
export function toast(type, title, desc = "", ms = 3600) {
  const root = qs("#toast-root");
  const ic = { success: "check", error: "x", warning: "warn", info: "info" }[type] || "info";
  const node = el(`<div class="toast ${type}">
    <span class="a-ico">${icon(ic)}</span>
    <div class="a-body"><div class="a-title">${esc(title)}</div>${desc ? `<div class="a-desc muted">${esc(desc)}</div>` : ""}</div>
    <span class="x">${icon("x")}</span>
  </div>`);
  const kill = () => { node.style.opacity = "0"; node.style.transform = "translateX(8px)"; setTimeout(() => node.remove(), 180); };
  node.querySelector(".x").onclick = kill;
  root.appendChild(node);
  if (ms) setTimeout(kill, ms);
  return kill;
}

/* ---------- Overlays (modal / drawer) ---------- */
export function closeOverlay() {
  qsa("#overlay-root > *").forEach((n) => n.remove());
  document.body.style.overflow = "";
}
export function openModal({ title, body, footer, width, onMount }) {
  closeOverlay();
  const root = qs("#overlay-root");
  const scrim = el(`<div class="scrim"></div>`);
  const modal = el(`<div class="modal" style="${width ? `width:${width}px` : ""}" role="dialog" aria-modal="true">
    <div class="modal-head"><h3>${esc(title)}</h3><div class="spacer"></div><button class="icon-btn" data-close>${icon("x")}</button></div>
    <div class="modal-body">${body}</div>
    ${footer ? `<div class="modal-foot">${footer}</div>` : ""}
  </div>`);
  scrim.onclick = closeOverlay;
  root.append(scrim, modal);
  document.body.style.overflow = "hidden";
  modal.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeOverlay));
  onMount && onMount(modal);
  return modal;
}
export function openDrawer({ title, body, onMount }) {
  closeOverlay();
  const root = qs("#overlay-root");
  const scrim = el(`<div class="scrim"></div>`);
  const drawer = el(`<div class="drawer" role="dialog" aria-modal="true">
    <div class="drawer-head"><h3 class="text-lg fw-700">${esc(title)}</h3><div class="spacer"></div><button class="icon-btn" data-close>${icon("x")}</button></div>
    <div style="padding:20px">${body}</div>
  </div>`);
  scrim.onclick = closeOverlay;
  root.append(scrim, drawer);
  document.body.style.overflow = "hidden";
  drawer.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeOverlay));
  onMount && onMount(drawer);
  return drawer;
}
export function confirmDialog({ title, message, confirmText = "Confirm", danger = true, onConfirm }) {
  openModal({
    title, width: 420,
    body: `<p class="muted">${esc(message)}</p>`,
    footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-ok>${esc(confirmText)}</button>`,
    onMount: (m) => { m.querySelector("[data-ok]").onclick = () => { onConfirm(); closeOverlay(); }; },
  });
}

/* ---------- Dropdown menu ---------- */
export function openMenu(anchor, items, options = "right") {
  const config = typeof options === "string" ? { align: options } : { align: "right", placement: "bottom", ...options };
  qsa(".menu").forEach((m) => m.remove());
  const menu = el(`<div class="menu"></div>`);
  items.forEach((it) => {
    if (it.sep) return menu.appendChild(el(`<div class="menu-sep"></div>`));
    if (it.label) return menu.appendChild(el(`<div class="menu-label">${esc(it.label)}</div>`));
    const item = el(`<div class="menu-item ${it.danger ? "danger" : ""}">${it.icon ? icon(it.icon) : ""}<span>${esc(it.text)}</span></div>`);
    item.onclick = () => { menu.remove(); it.onClick && it.onClick(); };
    menu.appendChild(item);
  });
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = config.align === "right" ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  const top = config.placement === "top" ? r.top - mh - 6 : r.bottom + 6;
  menu.style.left = left + "px";
  menu.style.top = Math.max(8, top) + "px";
  const off = (e) => { if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener("mousedown", off); } };
  setTimeout(() => document.addEventListener("mousedown", off), 0);
  return menu;
}

/* ============================================================
   Charts (pure SVG)
   ============================================================ */
function scale(v, min, max, a, b) { return max === min ? (a + b) / 2 : a + ((v - min) / (max - min)) * (b - a); }
function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    const cx = (p0[0] + p1[0]) / 2;
    d += ` C ${cx},${p0[1]} ${cx},${p1[1]} ${p1[0]},${p1[1]}`;
  }
  return d;
}

export function lineChart({ series, labels = [], w = 640, h = 240, area = true, yMax, showAxis = true }) {
  const padL = showAxis ? 34 : 6, padR = 8, padT = 12, padB = showAxis ? 26 : 6;
  const iw = w - padL - padR, ih = h - padT - padB;
  const all = series.flatMap((s) => s.data);
  const max = yMax || Math.max(1, ...all) * 1.15;
  const min = 0;
  const n = series[0]?.data.length || 1;
  const xAt = (i) => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yAt = (v) => padT + ih - scale(v, min, max, 0, ih);
  let grid = "";
  const rows = 4;
  for (let r = 0; r <= rows; r++) {
    const y = padT + (r / rows) * ih;
    grid += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="var(--chart-grid)"/>`;
    if (showAxis) grid += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="var(--text-3)" font-size="12">${Math.round(max - (r / rows) * max)}</text>`;
  }
  let xlabels = "";
  if (showAxis && labels.length) labels.forEach((lb, i) => {
    xlabels += `<text x="${xAt(i)}" y="${h - 8}" text-anchor="middle" fill="var(--text-3)" font-size="12">${esc(lb)}</text>`;
  });
  const paths = series.map((s, si) => {
    const pts = s.data.map((v, i) => [xAt(i), yAt(v)]);
    const d = smoothPath(pts);
    const gid = `g${si}_${Math.random().toString(36).slice(2, 6)}`;
    const areaFill = area ? `<defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity="0.28"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs><path d="${d} L ${xAt(n - 1)},${padT + ih} L ${xAt(0)},${padT + ih} Z" fill="url(#${gid})"/>` : "";
    const dots = s.data.map((v, i) => `<g class="cd"><circle cx="${xAt(i)}" cy="${yAt(v)}" r="11" fill="transparent"><title>${esc(s.name)}: ${v}${labels[i] ? " · " + esc(labels[i]) : ""}</title></circle><circle class="chart-dot-hover" cx="${xAt(i)}" cy="${yAt(v)}" r="2.6" fill="var(--surface)" stroke="${s.color}" stroke-width="2" pointer-events="none"/></g>`).join("");
    return `${areaFill}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.4"/>${dots}`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="none" style="display:block">${grid}${paths}${xlabels}</svg>`;
}

export function sparkline(data, color = "var(--violet-400)", w = 90, h = 34) {
  const max = Math.max(...data), min = Math.min(...data);
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - 3 - scale(v, min, max, 0, h - 6)]);
  const d = smoothPath(pts);
  const gid = "sp" + Math.random().toString(36).slice(2, 7);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.3"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="${d} L ${w},${h} L 0,${h} Z" fill="url(#${gid})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
}

export function donut({ segments, size = 180, thickness = 22, centerLabel = "", centerSub = "" }) {
  const r = (size - thickness) / 2, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  let off = 0;
  const rings = segments.map((s) => {
    const frac = s.value / total, len = frac * C;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${thickness}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt"/>`;
    off += len;
    return seg;
  }).join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="${thickness}"/>
    ${rings}
    ${centerLabel ? `<text x="${cx}" y="${cy - 2}" text-anchor="middle" fill="var(--text)" font-size="26" font-weight="800">${esc(centerLabel)}</text>` : ""}
    ${centerSub ? `<text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="var(--text-3)" font-size="12">${esc(centerSub)}</text>` : ""}
  </svg>`;
}

export function ring(pct, size = 72, thickness = 8, color = "var(--primary)") {
  const r = (size - thickness) / 2, cx = size / 2, C = 2 * Math.PI * r, len = (pct / 100) * C;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="${thickness}"/>
    <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${color}" stroke-width="${thickness}" stroke-linecap="round" stroke-dasharray="${len} ${C}" transform="rotate(-90 ${cx} ${cx})"/>
    <text x="${cx}" y="${cx + 4}" text-anchor="middle" fill="var(--text)" font-size="15" font-weight="700">${pct}%</text>
  </svg>`;
}

export function bars(values, { w = 120, h = 44, color = "var(--violet-400)" } = {}) {
  const max = Math.max(...values), bw = w / values.length - 3;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${values.map((v, i) => {
    const bh = scale(v, 0, max, 3, h);
    return `<rect x="${i * (bw + 3)}" y="${h - bh}" width="${bw}" height="${bh}" rx="2" fill="${color}"/>`;
  }).join("")}</svg>`;
}

export function randomSeries(n = 12, base = 50, spread = 40) {
  return Array.from({ length: n }, () => Math.round(base + (Math.random() - 0.5) * spread));
}
