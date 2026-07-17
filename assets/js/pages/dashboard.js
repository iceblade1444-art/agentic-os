import { store, timeAgo } from "../store.js";
import { icon } from "../icons.js";
import { agentIcon, statusBadge, sparkline, lineChart, donut, esc, randomSeries } from "../ui.js";

const HELLO = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

const orbSVG = () => `<svg width="196" height="196" viewBox="0 0 196 196" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="orbBody" cx="40%" cy="34%" r="72%">
      <stop offset="0" stop-color="#d8ccff"/><stop offset="42%" stop-color="#8b5cf6"/>
      <stop offset="78%" stop-color="#5b21b6"/><stop offset="100%" stop-color="#2a0a55"/>
    </radialGradient>
    <radialGradient id="orbHi" cx="36%" cy="28%" r="40%">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="orbGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#7c3aed" stop-opacity="0.55"/><stop offset="100%" stop-color="#7c3aed" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="98" cy="98" r="92" fill="url(#orbGlow)"/>
  <ellipse cx="98" cy="98" rx="90" ry="30" fill="none" stroke="#a78bfa" stroke-opacity="0.45" stroke-width="1.5" transform="rotate(-22 98 98)"/>
  <ellipse cx="98" cy="98" rx="86" ry="24" fill="none" stroke="#c4b5fd" stroke-opacity="0.3" stroke-width="1.5" transform="rotate(18 98 98)"/>
  <circle cx="98" cy="98" r="60" fill="url(#orbBody)"/>
  <circle cx="98" cy="98" r="60" fill="url(#orbHi)"/>
  <circle cx="150" cy="72" r="3" fill="#c4b5fd"/><circle cx="44" cy="120" r="2.4" fill="#a78bfa"/><circle cx="158" cy="130" r="2" fill="#8b5cf6"/>
</svg>`;

function statCard(label, value, delta, up, icoName, spark) {
  return `<div class="stat">
    <div class="stat-top">
      <span class="stat-label">${label}</span>
      <span class="stat-ico">${icon(icoName)}</span>
    </div>
    <div class="stat-value">${value}</div>
    <div class="stat-delta ${up ? "up" : "down"}">${icon(up ? "up" : "down")} ${delta}</div>
    ${sparkline(spark, up ? "var(--success)" : "var(--error)")}
  </div>`;
}

export default {
  title: "Home",
  render() {
    const s = store.state;
    const stats = s.stats;
    const activitySeries = [
      { name: "Tasks", color: "var(--violet-500)", data: [30, 42, 38, 55, 48, 62, 70] },
      { name: "Success Rate", color: "var(--success)", data: [55, 50, 63, 58, 72, 68, 82] },
    ];
    const labels = ["May 10", "May 11", "May 12", "May 13", "May 14", "May 15", "May 16"];
    const taskCounts = {
      completed: s.tasks.filter((t) => t.status === "completed").length,
      in_progress: s.tasks.filter((t) => t.status === "in_progress").length,
      queued: s.tasks.filter((t) => t.status === "queued").length,
    };
    const donutSegs = [
      { label: "Completed", value: 68, color: "var(--success)" },
      { label: "In Progress", value: 18, color: "var(--warning)" },
      { label: "Failed", value: 8, color: "var(--error)" },
      { label: "Queued", value: 6, color: "var(--text-3)" },
    ];

    return `
    <div class="hero">
      <div>
        <div class="row gap-2 mb-4"><span class="badge primary">${icon("sparkles")} Agentic OS · v1.0</span></div>
        <h1>${HELLO()}, <span class="grad">${esc(s.profile.name.split(" ")[0])}</span> ☀️</h1>
        <p>Build, run and orchestrate intelligent agents with the tools, guardrails and infrastructure they need to get real work done.</p>
        <div class="hero-chips">
          <span class="hero-chip">${icon("agents")} Agent Orchestration</span>
          <span class="hero-chip">${icon("memory")} Memory &amp; Context</span>
          <span class="hero-chip">${icon("tools")} Tools &amp; Integrations</span>
          <span class="hero-chip">${icon("guardrails")} Secure &amp; Scalable</span>
        </div>
        <div class="hero-cta">
          <a class="btn btn-primary lg" id="dashNew" href="#/kanban/new">${icon("plus")}<span>New task</span></a>
          <a class="btn btn-secondary lg" href="#/kanban">${icon("workflow")}<span>Open Kanban</span></a>
        </div>
      </div>
      <div class="hero-orb">${orbSVG()}</div>
    </div>

    <div class="grid cols-4" style="margin-bottom:16px">
      ${statCard("Active Agents", stats.activeAgents, "12%", true, "agents", randomSeries(10, 20, 8))}
      ${statCard("Tasks Running", stats.tasksRunning, "8%", true, "activity", randomSeries(10, 8, 6))}
      ${statCard("Success Rate", stats.successRate + "%", "2.1%", true, "evaluations", randomSeries(10, 95, 6))}
      ${statCard("Tokens Used", stats.tokensUsed, "15%", true, "zap", randomSeries(10, 40, 20))}
    </div>

    <div class="grid" style="grid-template-columns:2fr 1fr;margin-bottom:16px">
      <div class="card pad-lg">
        <div class="card-head">
          <h3>Activity Overview</h3><div class="spacer"></div>
          <div class="pill-tabs" id="rangeTabs"><button class="active">7D</button><button>30D</button><button>90D</button></div>
        </div>
        <div class="row gap-4 mb-4" style="font-size:13px">
          <span class="row gap-2"><span class="status-dot" style="background:var(--violet-500)"></span>Tasks</span>
          <span class="row gap-2"><span class="status-dot" style="background:var(--success)"></span>Success Rate</span>
        </div>
        ${lineChart({ series: activitySeries, labels, w: 720, h: 260 })}
      </div>

      <div class="card pad-lg">
        <div class="card-head"><h3>Recent Activity</h3></div>
        <div class="stack gap-2">
          ${s.activity.map((a) => `
            <div class="row gap-3" style="padding:8px 0">
              ${agentIcon({ color: a.color, icon: a.icon }, 30)}
              <div class="stack" style="min-width:0">
                <span class="fw-600">${esc(a.agent)}</span>
                <span class="cell-sub">${esc(a.text)}</span>
              </div>
              <div class="spacer"></div>
              <span class="dim text-sm nowrap">${timeAgo(a.at)}</span>
            </div>`).join("")}
        </div>
        <a class="btn btn-ghost sm mt-2" href="#/observability">View all activity ${icon("arrowright")}</a>
      </div>
    </div>

    <div class="grid" style="grid-template-columns:1.4fr 1fr 1fr">
      <div class="card pad-lg">
        <div class="card-head"><h3>Top Agents</h3><div class="spacer"></div><a class="btn btn-ghost sm" href="#/agents">View all</a></div>
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>Agent</th><th>Tasks</th><th>Success</th><th>Trend</th></tr></thead>
            <tbody>
              ${[...s.agents].sort((a, b) => b.tasks - a.tasks).slice(0, 5).map((a) => `
                <tr>
                  <td><div class="cell-main">${agentIcon(a, 30)}<div class="stack"><span class="fw-600">${esc(a.name)}</span><span class="cell-sub">${esc(a.type)}</span></div></div></td>
                  <td class="mono">${a.tasks}</td>
                  <td>${a.successRate}%</td>
                  <td>${sparkline(randomSeries(8, 60, 30), "var(--success)", 70, 26)}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card pad-lg">
        <div class="card-head"><h3>Tasks by Status</h3></div>
        <div class="row gap-4" style="align-items:center">
          <div style="flex:none">${donut({ segments: donutSegs, size: 150, thickness: 20, centerLabel: String(s.tasks.length), centerSub: "Total" })}</div>
          <div class="stack gap-2" style="flex:1">
            ${donutSegs.map((d) => `<div class="row gap-2 text-sm"><span class="status-dot" style="background:${d.color}"></span><span class="muted">${d.label}</span><div class="spacer"></div><span class="fw-600">${d.value}%</span></div>`).join("")}
          </div>
        </div>
      </div>

      <div class="card pad-lg">
        <div class="card-head"><h3>System Health</h3></div>
        <div class="row gap-2 text-sm muted mb-4">${icon("shield")} All systems operational</div>
        <div class="stack gap-4">
          ${s.health.map((h) => `<div><div class="row between text-sm mb-4" style="margin-bottom:6px"><span class="muted">${h.name}</span><span class="fw-600">${h.value}%</span></div><div class="progress"><span style="width:${h.value}%"></span></div></div>`).join("")}
        </div>
      </div>
    </div>`;
  },

  mount(root) {
    root.querySelectorAll("#rangeTabs button").forEach((b) =>
      b.addEventListener("click", () => {
        root.querySelectorAll("#rangeTabs button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      })
    );
  },
};
