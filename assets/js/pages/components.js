import { icon, ICON_NAMES } from "../icons.js";
import { toast, openModal, openMenu, closeOverlay, ring, esc } from "../ui.js";

const block = (n, title, inner) => `<div class="card pad-lg"><div class="section-title">${n}. ${title}</div>${inner}</div>`;

export default {
  title: "Components",
  render() {
    return `
    <div class="page-head"><div><div class="page-title">Component Library</div><div class="page-sub">The Agentic OS design system — buttons, inputs, data display, feedback, tokens.</div></div></div>
    <div class="grid cols-2" style="align-items:start">

      ${block(1, "Buttons", `
        <div class="row wrap gap-2 mb-4">
          <button class="btn btn-primary">Primary</button>
          <button class="btn btn-secondary">Secondary</button>
          <button class="btn btn-outline">Outline</button>
          <button class="btn btn-ghost">Ghost</button>
          <button class="btn btn-danger">Danger</button>
        </div>
        <div class="section-title">States</div>
        <div class="row wrap gap-2">
          <button class="btn btn-primary">Default</button>
          <button class="btn btn-primary" style="background:var(--primary-hover)">Hover</button>
          <button class="btn btn-primary disabled">Disabled</button>
          <button class="btn btn-primary loading">Loading</button>
          <button class="btn btn-secondary">${icon("plus")}With icon</button>
        </div>`)}

      ${block(2, "Inputs", `
        <div class="field"><label class="label">Default</label><input class="input" placeholder="Input text"/></div>
        <div class="field"><label class="label">Error</label><input class="input error" value="Invalid value"/><span class="field-error">This field is required</span></div>
        <div class="field"><label class="label">Select</label><select class="select"><option>Select option</option><option>GPT-4o</option><option>Claude Sonnet 5</option></select></div>
        <div class="field"><label class="label">Textarea</label><textarea class="textarea" placeholder="Type your message…"></textarea></div>
        <div class="row gap-6 mt-2">
          <label class="check"><input type="checkbox" checked/> Checkbox</label>
          <label class="check"><input type="radio" name="r" checked/> Radio</label>
          <label class="switch"><input type="checkbox" checked/><span class="track"></span><span class="thumb"></span></label>
        </div>`)}

      ${block(3, "Badges & Chips", `
        <div class="row wrap gap-2 mb-4">
          <span class="badge neutral">Neutral</span><span class="badge primary">Primary</span>
          <span class="badge success"><span class="dot"></span>Success</span><span class="badge warning"><span class="dot"></span>Warning</span>
          <span class="badge error"><span class="dot"></span>Error</span><span class="badge info">Info</span>
        </div>
        <div class="row wrap gap-2">
          <span class="chip">Default ${icon("x")}</span><span class="chip">AI <span class="x">${icon("x")}</span></span><span class="chip">Agent <span class="x">${icon("x")}</span></span>
        </div>`)}

      ${block(4, "Tabs & Navigation", `
        <div class="tabs mb-4"><button class="tab active">Overview</button><button class="tab">Activity</button><button class="tab">Logs</button><button class="tab">Settings</button></div>
        <div class="section-title">Pills</div>
        <div class="pill-tabs mb-4"><button class="active">All</button><button>Active</button><button>Archived</button></div>
        <div class="section-title">Breadcrumb</div>
        <div class="row gap-2 text-sm muted mb-4">Home ${icon("chevright")} Agents ${icon("chevright")} <span class="fw-600" style="color:var(--text)">Research Agent</span></div>
        <div class="section-title">Pagination</div>
        <div class="row gap-2"><button class="icon-btn">${icon("chevleft")}</button>${[1, 2, 3].map((n) => `<button class="btn sm ${n === 1 ? "btn-primary" : "btn-ghost"}">${n}</button>`).join("")}<span class="dim">…</span><button class="btn sm btn-ghost">8</button><button class="icon-btn">${icon("chevright")}</button></div>`)}

      ${block(5, "Progress", `
        <div class="row between text-sm mb-4"><span class="muted">Determinate</span><span class="fw-600">60%</span></div>
        <div class="progress mb-4"><span style="width:60%"></span></div>
        <div class="section-title">Indeterminate</div>
        <div class="progress indeterminate mb-4"><span></span></div>
        <div class="row gap-6" style="align-items:center"><div>${ring(75, 72, 8)}</div><div>${ring(42, 72, 8, "var(--warning)")}</div><div>${ring(96, 72, 8, "var(--success)")}</div></div>`)}

      ${block(6, "Feedback / Alerts", `
        <div class="stack gap-2">
          <div class="alert success"><span class="a-ico">${icon("check")}</span><div class="a-body"><div class="a-title">Success!</div><div class="a-desc">Your changes have been saved.</div></div></div>
          <div class="alert warning"><span class="a-ico">${icon("warn")}</span><div class="a-body"><div class="a-title">Warning</div><div class="a-desc">Please review your configuration.</div></div></div>
          <div class="alert error"><span class="a-ico">${icon("x")}</span><div class="a-body"><div class="a-title">Error!</div><div class="a-desc">Something went wrong.</div></div></div>
          <div class="alert info"><span class="a-ico">${icon("info")}</span><div class="a-body"><div class="a-title">Info</div><div class="a-desc">Here's some information.</div></div></div>
        </div>
        <div class="row wrap gap-2 mt-4">
          <button class="btn btn-secondary sm" data-toast="success">Toast success</button>
          <button class="btn btn-secondary sm" data-toast="error">Toast error</button>
          <button class="btn btn-secondary sm" data-toast="warning">Toast warning</button>
          <button class="btn btn-secondary sm" data-toast="info">Toast info</button>
        </div>`)}

      ${block(7, "Overlays", `
        <div class="row gap-2 mb-4">
          <button class="btn btn-primary" id="c-modal">Open modal</button>
          <button class="btn btn-secondary" id="c-menu">Open dropdown</button>
        </div>
        <div class="section-title">Tooltip</div>
        <span class="tip" data-tip="This is a tooltip"><button class="btn btn-outline sm">Hover me ${icon("help")}</button></span>`)}

      ${block(8, "Code block", `
        <div class="codeblock">
          <div class="cb-head"><span class="badge neutral">Python</span><div class="spacer"></div><button class="btn sm btn-ghost" id="c-copy">${icon("copy")}Copy</button></div>
<pre><span class="tok-key">from</span> agentic <span class="tok-key">import</span> Agent, tool

agent = <span class="tok-fn">Agent</span>(
  name=<span class="tok-str">"Research Agent"</span>,
  instructions=<span class="tok-str">"You are a helpful research assistant."</span>,
  tools=[search_web, analyze_data],
)
result = agent.<span class="tok-fn">run</span>(<span class="tok-str">"Latest trends in AI agents"</span>)
<span class="tok-fn">print</span>(result)</pre>
        </div>`)}

      ${block(9, "Empty & loading", `
        <div class="grid cols-2" style="gap:12px">
          <div class="card" style="background:var(--surface-2)"><div class="empty" style="padding:22px 10px"><div class="empty-ico">${icon("bot")}</div><h4>No agents yet</h4><p>Create your first agent.</p></div></div>
          <div class="card stack gap-3" style="background:var(--surface-2)">
            <div class="row gap-2"><div class="spinner"></div><span class="muted text-sm">Loading agents…</span></div>
            <div class="skeleton" style="height:12px;width:80%"></div>
            <div class="skeleton" style="height:12px;width:60%"></div>
            <div class="skeleton" style="height:40px"></div>
          </div>
        </div>`)}

      ${block(10, "Avatars", `
        <div class="row gap-3" style="align-items:center">
          <div class="avatar" style="width:28px;height:28px;background:var(--violet-600);color:#fff">SM</div>
          <div class="avatar" style="width:36px;height:36px;background:var(--info);color:#fff">MD</div>
          <div class="avatar" style="width:46px;height:46px;background:var(--success);color:#fff">LG</div>
          <div class="avatar" style="width:56px;height:56px;background:var(--warning);color:#fff">XL</div>
          <div class="row" style="margin-left:8px">
            ${["#7c3aed", "#3b82f6", "#22c55e", "#ec4899"].map((c, i) => `<div class="avatar" style="width:34px;height:34px;background:${c};color:#fff;margin-left:${i ? -10 : 0}px;border:2px solid var(--surface)">${String.fromCharCode(65 + i)}</div>`).join("")}
            <div class="avatar" style="width:34px;height:34px;margin-left:-10px;border:2px solid var(--surface)">+3</div>
          </div>
        </div>`)}
    </div>

    ${block(11, "Design tokens", `
      <div class="grid cols-2" style="gap:24px">
        <div>
          <div class="section-title">Colors</div>
          <div class="grid" style="grid-template-columns:repeat(6,1fr);gap:8px">
            ${[["Primary", "var(--violet-600)"], ["Primary 400", "var(--violet-400)"], ["Success", "var(--success)"], ["Warning", "var(--warning)"], ["Error", "var(--error)"], ["Info", "var(--info)"]].map(([n, c]) => `<div><div class="token-swatch" style="background:${c}"></div><div class="hint mt-2">${n}</div></div>`).join("")}
          </div>
          <div class="section-title mt-6">Neutrals</div>
          <div class="grid" style="grid-template-columns:repeat(6,1fr);gap:8px">
            ${["var(--bg)", "var(--bg-1)", "var(--surface)", "var(--surface-2)", "var(--surface-3)", "var(--border-strong)"].map((c) => `<div class="token-swatch" style="background:${c}"></div>`).join("")}
          </div>
        </div>
        <div>
          <div class="section-title">Typography — Inter</div>
          <div class="row gap-4" style="align-items:baseline"><span style="font-size:48px;font-weight:800;letter-spacing:-.03em">Ag</span><div class="stack"><span class="fw-700">Inter</span><span class="hint">Aa Bb Cc Dd · 0123456789</span></div></div>
          <div class="stack gap-2 mt-4 text-sm">
            <div class="row between"><span style="font-size:22px;font-weight:800">Heading</span><span class="dim">28 / Bold</span></div>
            <div class="row between"><span style="font-size:16px;font-weight:600">Subheading</span><span class="dim">16 / SemiBold</span></div>
            <div class="row between"><span>Body text</span><span class="dim">14 / Regular</span></div>
          </div>
          <div class="section-title mt-6">Radius &amp; spacing</div>
          <div class="row gap-2">${[6, 10, 14, 18, 24].map((r) => `<div style="width:44px;height:44px;background:var(--surface-3);border:1px solid var(--border);border-radius:${r}px"></div>`).join("")}</div>
          <div class="row gap-2 mt-4">${[4, 8, 12, 16, 24, 32].map((s) => `<div class="stack" style="align-items:center"><div style="width:${s}px;height:${s}px;background:var(--primary)"></div><span class="dim" style="font-size:12px">${s}</span></div>`).join("")}</div>
        </div>
      </div>`)}

    ${block(12, "Icon set", `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(46px,1fr));gap:8px">${ICON_NAMES.map((n) => `<div class="tip" data-tip="${n}" style="display:grid;place-items:center;height:46px;border:1px solid var(--border);border-radius:10px;color:var(--text-2)">${icon(n)}</div>`).join("")}</div>`)}
    `;
  },

  mount(root) {
    root.querySelectorAll("[data-toast]").forEach((b) => (b.onclick = () => toast(b.dataset.toast, "This is a " + b.dataset.toast + " toast", "Triggered from the component library.")));
    root.querySelector("#c-modal").onclick = () => openModal({
      title: "Create new agent", width: 460,
      body: `<div class="field"><label class="label">Name</label><input class="input" placeholder="My New Agent"/></div><div class="field"><label class="label">Model</label><select class="select"><option>GPT-4o</option><option>Claude Sonnet 5</option></select></div>`,
      footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="dm-ok">Create</button>`,
      onMount: (m) => (m.querySelector("#dm-ok").onclick = () => { closeOverlay(); toast("success", "Agent created"); }),
    });
    root.querySelector("#c-menu").onclick = (e) => openMenu(e.currentTarget, [
      { label: "Profile" },
      { text: "Settings", icon: "settings" }, { text: "Billing", icon: "card" }, { text: "Documentation", icon: "file" },
      { sep: true }, { text: "Sign out", icon: "logout", danger: true },
    ], "left");
    const copy = root.querySelector("#c-copy");
    if (copy) copy.onclick = () => toast("success", "Copied to clipboard");
  },
};
