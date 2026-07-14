import { store } from "../store.js";
import { icon } from "../icons.js";
import { toast, esc } from "../ui.js";

const META = {
  trigger: { label: "Trigger", desc: "Event that starts workflow", color: "green", ic: "zap" },
  llm: { label: "LLM", desc: "Generate text with a model", color: "violet", ic: "sparkles" },
  tool: { label: "Tool", desc: "Call a tool or API", color: "blue", ic: "tools" },
  condition: { label: "Condition", desc: "Add logic branches", color: "amber", ic: "branch" },
  transform: { label: "Transform", desc: "Transform data/format", color: "cyan", ic: "refresh" },
  end: { label: "End", desc: "End workflow execution", color: "pink", ic: "check" },
};
const NODE_W = 180, PORT_Y = 30;

export default {
  title: "Workflows",
  render() {
    return `
    <div class="page-head" style="margin-bottom:14px">
      <div><div class="page-title">Workflow Builder</div><div class="page-sub">Design agent pipelines visually · drag to move, drag a node's right dot to connect</div></div>
      <div class="spacer"></div>
      <span class="chip" id="zoomLabel">100%</span>
      <button class="btn btn-secondary" id="wfSave">${icon("save")}Save</button>
      <button class="btn btn-primary" id="wfPublish">${icon("rocket")}Publish</button>
    </div>
    <div class="wf">
      <div class="wf-palette">
        <div class="section-title">Nodes</div>
        ${Object.entries(META).map(([type, m]) => `
          <button class="wf-node-btn" data-add="${type}">
            <div class="aico" style="background:${store.colors[m.color]}">${icon(m.ic)}</div>
            <div class="stack"><span class="t">${m.label}</span><span class="d">${m.desc}</span></div>
          </button>`).join("")}
      </div>
      <div class="wf-canvas" id="wfCanvas">
        <svg class="wf-edges" id="wfEdges"></svg>
      </div>
    </div>`;
  },

  mount(root) {
    const canvas = root.querySelector("#wfCanvas");
    const svg = root.querySelector("#wfEdges");
    let selected = null, linking = null;

    function nodeById(id) { return store.state.workflow.nodes.find((n) => n.id === id); }

    function drawNode(n) {
      const m = META[n.type] || META.tool;
      const node = document.createElement("div");
      node.className = "wf-node" + (selected === n.id ? " sel" : "");
      node.style.left = n.x + "px"; node.style.top = n.y + "px";
      node.dataset.id = n.id;
      node.innerHTML = `
        <div class="wf-port in"></div>
        <div class="n-head"><div class="aico" style="background:${store.colors[m.color]}">${icon(m.ic)}</div><span class="n-title">${esc(n.title)}</span></div>
        <div class="n-sub">${esc(n.sub || m.desc)}</div>
        <div class="wf-port out" title="Drag to connect"></div>`;
      canvas.appendChild(node);
      makeDraggable(node, n);
      node.querySelector(".wf-port.out").addEventListener("pointerdown", (e) => startLink(e, n));
      node.addEventListener("pointerdown", (e) => { if (!e.target.classList.contains("wf-port")) select(n.id); });
      return node;
    }

    function renderAll() {
      canvas.querySelectorAll(".wf-node").forEach((n) => n.remove());
      store.state.workflow.nodes.forEach(drawNode);
      drawEdges();
    }

    function portPos(n, side) {
      return { x: n.x + (side === "out" ? NODE_W : 0), y: n.y + PORT_Y };
    }
    function edgePath(a, b) {
      const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
      return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    }
    function drawEdges(temp) {
      const edges = store.state.workflow.edges;
      let html = "";
      edges.forEach((e) => {
        const s = nodeById(e.from), t = nodeById(e.to); if (!s || !t) return;
        html += `<path d="${edgePath(portPos(s, "out"), portPos(t, "in"))}" fill="none" stroke="var(--border-strong)" stroke-width="2"/>`;
      });
      if (temp) html += `<path d="${edgePath(temp.a, temp.b)}" fill="none" stroke="var(--primary)" stroke-width="2" stroke-dasharray="5 4"/>`;
      svg.innerHTML = html;
    }

    function makeDraggable(node, n) {
      let sx, sy, ox, oy, moved;
      node.addEventListener("pointerdown", (e) => {
        if (e.target.classList.contains("wf-port")) return;
        moved = false; sx = e.clientX; sy = e.clientY; ox = n.x; oy = n.y;
        node.setPointerCapture(e.pointerId); node.style.cursor = "grabbing";
        const move = (ev) => {
          n.x = Math.max(0, ox + (ev.clientX - sx)); n.y = Math.max(0, oy + (ev.clientY - sy));
          node.style.left = n.x + "px"; node.style.top = n.y + "px"; moved = true; drawEdges();
        };
        const up = () => { node.removeEventListener("pointermove", move); node.style.cursor = "grab"; if (moved) store.persist(); };
        node.addEventListener("pointermove", move);
        node.addEventListener("pointerup", up, { once: true });
      });
    }

    function startLink(e, from) {
      e.stopPropagation();
      const rect = canvas.getBoundingClientRect();
      const a = portPos(from, "out");
      const move = (ev) => { linking = { from: from.id, a, b: { x: ev.clientX - rect.left, y: ev.clientY - rect.top } }; drawEdges(linking); };
      const up = (ev) => {
        document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
        const target = ev.target.closest(".wf-node");
        if (target && target.dataset.id !== from.id) {
          const to = target.dataset.id;
          if (!store.state.workflow.edges.some((x) => x.from === from.id && x.to === to)) {
            store.set((s) => s.workflow.edges.push({ from: from.id, to }));
            toast("success", "Nodes connected");
          }
        }
        linking = null; drawEdges();
      };
      document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
    }

    function select(id) {
      selected = id;
      canvas.querySelectorAll(".wf-node").forEach((n) => n.classList.toggle("sel", n.dataset.id === id));
    }

    // palette add
    root.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => {
      const type = b.dataset.add, m = META[type];
      const id = store.uid("n");
      const node = { id, type, title: m.label, sub: m.desc, x: 60 + Math.random() * 120, y: 60 + Math.random() * 220 };
      store.set((s) => s.workflow.nodes.push(node));
      drawNode(node); drawEdges(); select(id);
      toast("info", m.label + " node added");
    }));

    // delete selected
    const onKey = (e) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selected && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
        store.set((s) => { s.workflow.nodes = s.workflow.nodes.filter((n) => n.id !== selected); s.workflow.edges = s.workflow.edges.filter((ed) => ed.from !== selected && ed.to !== selected); });
        selected = null; renderAll();
      }
    };
    document.addEventListener("keydown", onKey);

    root.querySelector("#wfSave").onclick = () => { store.persist(); toast("success", "Workflow saved", store.state.workflow.nodes.length + " nodes · " + store.state.workflow.edges.length + " connections"); };
    root.querySelector("#wfPublish").onclick = () => toast("success", "Workflow published", "Live and listening for triggers.");

    renderAll();
    // redraw edges on resize
    const ro = new ResizeObserver(() => drawEdges());
    ro.observe(canvas);
  },
};
