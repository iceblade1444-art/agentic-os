import { store, timeAgo } from "../store.js";
import { icon } from "../icons.js";
import { esc, toast, statusBadge, lineChart, donut, bars, ring, randomSeries, agentIcon, confirmDialog, openModal, closeOverlay } from "../ui.js";
import { api } from "../api.js";

const rerender = () => window.dispatchEvent(new HashChangeEvent("hashchange"));

function head(title, sub, actionHTML = "") {
  return `<div class="page-head"><div><div class="page-title">${title}</div><div class="page-sub">${sub}</div></div><div class="spacer"></div>${actionHTML}</div>`;
}
// lazily initialise auxiliary collections so seed stays lean
function ensure(key, factory) {
  if (!store.state[key]) store.set((s) => (s[key] = factory()));
  return store.state[key];
}

/* ============================ TOOLS ============================ */
export const tools = {
  title: "Skill Studio",
  render() {
    const actions = api.on && api.auth.canAdmin ? `<button class="btn btn-secondary" id="skillsHub">${icon("search")}Browse Hub</button><button class="btn btn-primary" id="skillNew">${icon("plus")}New skill</button>` : "";
    return head("Skill Studio", "Procedural knowledge loaded by Hermes only when an agent needs it", actions)
      + `<div id="skillStudioBody">${loadingCard("Reading the Hermes skill catalog…")}</div>`;
  },
  mount(root) {
    if (!api.on) {
      root.querySelector("#skillStudioBody").innerHTML = demoNote("Start the Node backend to manage the real Hermes skill catalog.");
      return;
    }
    skillStudioMount(root);
  },
};

function skillStudioMount(root) {
  const body = root.querySelector("#skillStudioBody");
  let skills = [];
  let profiles = [];
  let profile = "default";
  let query = "";

  const filtered = () => {
    const value = query.toLowerCase();
    return skills.filter((skill) => !value || `${skill.name} ${skill.description} ${skill.category}`.toLowerCase().includes(value));
  };

  const draw = () => {
    const visible = filtered();
    const enabled = skills.filter((skill) => skill.enabled).length;
    const custom = skills.filter((skill) => skill.provenance === "agent").length;
    body.innerHTML = `
      <div class="grid cols-4 mb-4">
        ${statMini("Installed skills", skills.length, "tools")}
        ${statMini("Enabled", enabled, "check")}
        ${statMini("Custom procedures", custom, "file")}
        ${statMini("Recorded uses", skills.reduce((sum, item) => sum + (Number(item.usage) || 0), 0), "activity")}
      </div>
      <div class="skill-studio-toolbar mb-4">
        <div class="search skill-search"><span>${icon("search")}</span><input id="skillSearch" value="${esc(query)}" placeholder="Search procedures, categories, capabilities…"/></div>
        <label class="field skill-profile-field"><span class="label">Agent profile</span><select class="select" id="skillProfile">${profiles.map((item) => `<option value="${esc(item.name)}" ${item.name === profile ? "selected" : ""}>${esc(item.display_name || item.name)}</option>`).join("")}</select></label>
      </div>
      <div class="row between mb-3"><div class="row gap-2"><span class="fw-700">${visible.length} skills</span><span class="hint">Profile: ${esc(profile)}</span></div><span class="hint">Skills load progressively and do not fill every prompt.</span></div>
      ${visible.length ? `<div class="grid cols-3">${visible.map(skillCard).join("")}</div>` : `<div class="empty"><div class="empty-ico">${icon("search")}</div><h4>No matching skills</h4><p>Try another name, category or capability.</p></div>`}`;
    bind();
  };

  const bind = () => {
    body.querySelector("#skillSearch")?.addEventListener("input", (event) => {
      query = event.target.value;
      draw();
      const input = body.querySelector("#skillSearch");
      input?.focus();
      input?.setSelectionRange(query.length, query.length);
    });
    body.querySelector("#skillProfile")?.addEventListener("change", async (event) => {
      profile = event.target.value || "default";
      await load();
    });
    body.querySelectorAll("[data-skill-open]").forEach((button) => button.addEventListener("click", () => openSkillEditor(skills.find((item) => item.name === button.dataset.skillOpen), profile, load)));
    body.querySelectorAll("[data-skill-toggle]").forEach((input) => input.addEventListener("change", async () => {
      input.disabled = true;
      try {
        await api.skills.toggle(input.dataset.skillToggle, input.checked, profile);
        const skill = skills.find((item) => item.name === input.dataset.skillToggle);
        if (skill) skill.enabled = input.checked;
        toast("success", input.checked ? "Skill enabled" : "Skill disabled", `${input.dataset.skillToggle} · ${profile}`);
        draw();
      } catch (error) {
        input.checked = !input.checked;
        input.disabled = false;
        toast("error", "Could not update skill", error.message);
      }
    }));
  };

  const load = async () => {
    body.innerHTML = loadingCard("Reading the Hermes skill catalog…");
    try {
      const [catalog, fleet] = await Promise.all([api.skills.list(profile), api.kanban.profiles().catch(() => ({ profiles: [] }))]);
      skills = Array.isArray(catalog) ? catalog : [];
      profiles = (fleet.profiles || []).length ? fleet.profiles : [{ name: "default", display_name: "Orchestrator" }];
      if (!profiles.some((item) => item.name === profile)) profile = profiles[0]?.name || "default";
      draw();
    } catch (error) {
      body.innerHTML = errCard(error.message || "Hermes skill catalog is unavailable");
    }
  };

  root.querySelector("#skillNew")?.addEventListener("click", () => openNewSkill(profile, load));
  root.querySelector("#skillsHub")?.addEventListener("click", () => openSkillsHub(profile, load));
  load();
}

function skillCard(skill) {
  const provenance = { agent: "Custom", bundled: "Bundled", hub: "Hub" }[skill.provenance] || skill.provenance || "Skill";
  return `<article class="card skill-card ${skill.enabled ? "" : "is-disabled"}">
    <div class="row between gap-2">
      <div class="aico">${icon(skill.provenance === "agent" ? "sparkles" : skill.provenance === "hub" ? "cloud" : "tools")}</div>
      ${api.auth.canAdmin ? `<label class="switch" title="Enable for this profile"><input type="checkbox" data-skill-toggle="${esc(skill.name)}" ${skill.enabled ? "checked" : ""}/><span class="track"></span><span class="thumb"></span></label>` : `<span class="badge ${skill.enabled ? "success" : "neutral"}">${skill.enabled ? "Enabled" : "Disabled"}</span>`}
    </div>
    <button class="skill-card-main" data-skill-open="${esc(skill.name)}">
      <span class="row between gap-2"><strong>${esc(skill.name)}</strong><span class="badge neutral">${esc(provenance)}</span></span>
      <span class="skill-description">${esc(skill.description || "No description")}</span>
      <span class="row between mt-3"><span class="badge info">${esc(skill.category || "general")}</span><span class="hint">${Number(skill.usage) || 0} uses</span></span>
    </button>
  </article>`;
}

function skillTemplate(name = "my-skill", description = "Describe what this skill does") {
  return `---
name: ${name}
description: ${description}
version: 1.0.0
metadata:
  hermes:
    tags: [agentic-os]
    category: operations
---

# ${name}

## When to Use

Use this skill when the task requires a repeatable procedure.

## Procedure

1. Inspect the current state and required inputs.
2. Execute the approved steps with existing Hermes tools.
3. Record the result and any reusable learning.

## Pitfalls

- Never invent commands or claim an action completed without verification.
- Ask for approval before irreversible or external actions.

## Verification

Confirm the expected output and report any remaining risk.
`;
}

function openNewSkill(profile, reload) {
  openModal({
    title: "Create Hermes skill",
    width: 760,
    body: `<div class="grid cols-2"><label class="field"><span class="label">Skill name</span><input class="input mono" id="newSkillName" placeholder="my-workflow"/></label><label class="field"><span class="label">Category</span><input class="input" id="newSkillCategory" value="operations"/></label></div><label class="field mt-3"><span class="label">SKILL.md</span><textarea class="textarea mono skill-editor" id="newSkillContent">${esc(skillTemplate())}</textarea></label>`,
    footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="createSkill">${icon("plus")}Create skill</button>`,
    onMount: (modal) => {
      const name = modal.querySelector("#newSkillName");
      const content = modal.querySelector("#newSkillContent");
      name.addEventListener("input", () => {
        if (content.dataset.edited) return;
        content.value = skillTemplate(name.value.trim() || "my-skill");
      });
      content.addEventListener("input", () => { content.dataset.edited = "true"; });
      modal.querySelector("#createSkill").onclick = async (event) => {
        const button = event.currentTarget;
        button.classList.add("loading");
        try {
          await api.skills.create({ name: name.value, category: modal.querySelector("#newSkillCategory").value, content: content.value, profile });
          closeOverlay();
          toast("success", "Skill created", `${name.value} is available to ${profile}.`);
          await reload();
        } catch (error) { toast("error", "Could not create skill", error.message); button.classList.remove("loading"); }
      };
    },
  });
}

async function openSkillEditor(skill, profile, reload) {
  if (!skill) return;
  openModal({ title: skill.name, width: 760, body: loadingCard("Loading SKILL.md…") });
  try {
    const result = await api.skills.content(skill.name, profile);
    const editable = api.auth.canAdmin && skill.provenance === "agent";
    openModal({
      title: skill.name,
      width: 760,
      body: `<div class="row gap-2 mb-3"><span class="badge info">${esc(skill.category || "general")}</span><span class="badge neutral">${esc(skill.provenance || "skill")}</span><span class="hint">${Number(skill.usage) || 0} recorded uses</span></div><textarea class="textarea mono skill-editor" id="skillContent" ${editable ? "" : "readonly"}>${esc(result.content || "")}</textarea>${editable ? "" : `<div class="alert info mt-3"><span class="a-ico">${icon("lock")}</span><div class="a-body"><div class="a-title">Source-managed skill</div><div class="a-desc">Bundled and Hub skills are updated from their source. Create a custom skill to maintain your own procedure.</div></div></div>`}`,
      footer: `<button class="btn btn-secondary" data-close>Close</button>${editable ? `<button class="btn btn-primary" id="saveSkill">${icon("check")}Save changes</button>` : ""}`,
      onMount: (modal) => {
        modal.querySelector("#saveSkill")?.addEventListener("click", async (event) => {
          const button = event.currentTarget;
          button.classList.add("loading");
          try {
            await api.skills.update({ name: skill.name, content: modal.querySelector("#skillContent").value, profile });
            closeOverlay();
            toast("success", "Skill updated", "Hermes will use the new procedure in future sessions.");
            await reload();
          } catch (error) { toast("error", "Could not update skill", error.message); button.classList.remove("loading"); }
        });
      },
    });
  } catch (error) {
    openModal({ title: skill.name, width: 520, body: errCard(error.message) });
  }
}

function openSkillsHub(profile, reload) {
  openModal({
    title: "Hermes Skills Hub",
    width: 860,
    body: `<div class="row gap-2"><div class="search" style="flex:1"><span>${icon("search")}</span><input id="hubQuery" placeholder="Search GitHub, official skills and skills.sh…"/></div><button class="btn btn-primary" id="hubSearch">Search</button></div><div id="hubResults" class="mt-4"><div class="empty" style="min-height:220px"><div class="empty-ico">${icon("cloud")}</div><h4>Find a reusable capability</h4><p>Results are inspected by Hermes before installation.</p></div></div>`,
    onMount: (modal) => {
      const results = modal.querySelector("#hubResults");
      const run = async () => {
        const value = modal.querySelector("#hubQuery").value.trim();
        if (!value) return;
        results.innerHTML = loadingCard("Searching trusted and community skill sources…");
        try {
          const response = await api.skills.hubSearch(value, profile);
          const items = response.results || [];
          results.innerHTML = items.length ? `<div class="stack gap-2">${items.map((item) => `<div class="skill-hub-row"><div><div class="row gap-2"><strong>${esc(item.name || item.identifier)}</strong><span class="badge ${item.trust_level === "builtin" || item.trust_level === "trusted" ? "success" : "neutral"}">${esc(item.trust_level || item.source || "community")}</span></div><div class="hint mt-1">${esc(item.description || "")}</div><div class="mono hint mt-1">${esc(item.identifier || "")}</div></div><button class="btn btn-secondary sm" data-hub-install="${esc(item.identifier)}">${icon("plus")}Install</button></div>`).join("")}</div>` : `<div class="empty"><h4>No skills found</h4><p>Try a broader capability name.</p></div>`;
          results.querySelectorAll("[data-hub-install]").forEach((button) => button.onclick = async () => {
            button.classList.add("loading");
            try {
              await api.skills.hubInstall(button.dataset.hubInstall, profile);
              button.textContent = "Installing…";
              button.disabled = true;
              toast("success", "Installation started", "Hermes is scanning and installing the selected skill.");
              setTimeout(async () => { closeOverlay(); await reload(); }, 3500);
            } catch (error) { toast("error", "Could not install skill", error.message); button.classList.remove("loading"); }
          });
        } catch (error) { results.innerHTML = errCard(error.message); }
      };
      modal.querySelector("#hubSearch").onclick = run;
      modal.querySelector("#hubQuery").addEventListener("keydown", (event) => { if (event.key === "Enter") run(); });
    },
  });
}

/* ============================ KNOWLEDGE ============================ */
export const knowledge = {
  title: "Knowledge",
  render() {
    const actions = `<button class="btn btn-secondary" id="knowledgeRefresh">${icon("refresh")}Refresh</button><button class="btn btn-primary" id="knowledgeNew">${icon("plus")}New note</button>`;
    return head("Obsidian Library", "Shared Markdown knowledge used by Hermes and Agentic OS agents", actions)
      + `<div id="knowledgeBody">${loadingCard("Reading Obsidian vault…")}</div>`;
  },
  mount(root) {
    if (!api.on) {
      root.querySelector("#knowledgeBody").innerHTML = demoNote("Start the Node backend to read the real Obsidian vault.");
      return;
    }
    knowledgeMount(root);
  },
};

function knowledgeBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function knowledgeAction(entry) {
  const labels = { list: "listed notes", read: "read", search: "searched", create: "created", append: "updated", graph: "mapped graph" };
  return labels[entry.action] || entry.action;
}

function knowledgeGraphHTML(graph, activePath) {
  const nodes = (graph?.nodes || []).slice(0, 48);
  const nodeSet = new Set(nodes.map((node) => node.id));
  const edges = (graph?.edges || []).filter((edge) => nodeSet.has(edge.source) && nodeSet.has(edge.target)).slice(0, 90);
  if (!nodes.length) return `<div class="knowledge-graph empty"><div class="empty-ico">${icon("network")}</div><h4>No graph yet</h4><p>Add Obsidian links like [[Project Roadmap]] to connect notes.</p></div>`;
  const center = { x: 360, y: 150 };
  const radius = nodes.length < 8 ? 86 : 116;
  const positions = new Map(nodes.map((node, index) => {
    const angle = (Math.PI * 2 * index) / nodes.length - Math.PI / 2;
    const weight = Math.min(1.35, 1 + (node.links || 0) * 0.04);
    return [node.id, {
      x: center.x + Math.cos(angle) * radius * weight,
      y: center.y + Math.sin(angle) * radius * weight,
    }];
  }));
  return `<div class="knowledge-graph">
    <div class="knowledge-section-head">
      <div><strong>Obsidian graph</strong><span>${nodes.length} notes · ${edges.length} resolved links · ${(graph?.edges || []).filter((edge) => !edge.resolved).length} open links</span></div>
      <span class="badge neutral">${icon("network")}Live map</span>
    </div>
    <svg viewBox="0 0 720 300" role="img" aria-label="Obsidian graph">
      ${edges.map((edge) => {
        const from = positions.get(edge.source);
        const to = positions.get(edge.target);
        if (!from || !to) return "";
        return `<line x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(1)}" x2="${to.x.toFixed(1)}" y2="${to.y.toFixed(1)}" class="${edge.resolved ? "resolved" : "open"}"/>`;
      }).join("")}
      ${nodes.map((node) => {
        const pos = positions.get(node.id);
        const active = node.id === activePath;
        const r = Math.min(18, 8 + (node.links || 0));
        return `<g class="knowledge-graph-node ${active ? "active" : ""}" data-note-path="${esc(node.id)}" transform="translate(${pos.x.toFixed(1)} ${pos.y.toFixed(1)})">
          <circle r="${r}"></circle>
          <text y="${r + 14}">${esc(node.label).slice(0, 22)}</text>
        </g>`;
      }).join("")}
    </svg>
  </div>`;
}

function knowledgeMount(root) {
  const body = root.querySelector("#knowledgeBody");
  let status = null;
  let notes = [];
  let usage = [];
  let graph = null;
  let selected = null;
  let query = "";
  let searchTimer = null;

  const draw = () => {
    if (!status) return;
    const activePath = selected?.path || "";
    body.innerHTML = `
      <div class="grid cols-4 knowledge-stats">
        ${statMini("Notes", status.notes, "file")}
        ${statMini("Folders", status.folders, "knowledge")}
        ${statMini("Vault size", knowledgeBytes(status.bytes), "database")}
        ${statMini("Agent access", status.mcp.status === "active" ? "Active" : "Offline", "network")}
      </div>
      <div class="knowledge-status">
        <span class="knowledge-logo">${icon("book")}</span>
        <div><strong>${esc(status.name)}</strong><span class="mono">${esc(status.path)}</span></div>
        <span class="badge ${status.ready && status.writable ? "success" : "warning"}"><span class="dot"></span>${status.writable ? "Read + write" : "Read only"}</span>
        <span class="badge ${status.mcp.status === "active" ? "success" : "error"}"><span class="dot"></span>MCP ${esc(status.mcp.status)}</span>
        <span class="knowledge-updated">${status.updatedAt ? `Updated ${timeAgo(status.updatedAt)}` : "Empty vault"}</span>
      </div>
      ${knowledgeGraphHTML(graph, activePath)}
      <div class="knowledge-workspace">
        <section class="knowledge-browser" aria-label="Obsidian notes">
          <div class="knowledge-toolbar">
            <div class="search knowledge-search">${icon("search")}<input id="knowledgeSearch" value="${esc(query)}" placeholder="Search notes, tags and folders…"/></div>
            <span>${notes.length} notes</span>
          </div>
          <div class="knowledge-note-list" id="knowledgeNoteList">
            ${notes.length ? notes.map((note) => `<button class="knowledge-note ${note.path === activePath ? "active" : ""}" type="button" data-note-path="${esc(note.path)}">
              <span class="knowledge-note-icon">${icon("file")}</span>
              <span class="knowledge-note-copy"><strong>${esc(note.title)}</strong><small>${esc(note.path)}</small><em>${esc(note.excerpt || "Empty note")}</em></span>
              <span class="knowledge-note-meta"><time>${timeAgo(note.updatedAt)}</time><small>${knowledgeBytes(note.size)}</small></span>
            </button>`).join("") : `<div class="empty knowledge-empty"><div class="empty-ico">${icon("search")}</div><h4>No notes found</h4><p>Try another search or create a note.</p></div>`}
          </div>
        </section>
        <section class="knowledge-inspector" aria-label="Selected Obsidian note">
          <div class="knowledge-preview" id="knowledgePreview">
            ${selected ? `<div class="knowledge-preview-head"><div><strong>${esc(selected.title)}</strong><span>${esc(selected.path)}</span></div><span class="badge neutral">${knowledgeBytes(selected.size)}</span></div>
              <div class="knowledge-note-facts">
                <span>${icon("layers")}${esc(selected.folder)}</span>
                <span>${icon("network")}${selected.links.length} links</span>
                <span>${icon("clock")}${timeAgo(selected.updatedAt)}</span>
              </div>
              ${selected.tags.length ? `<div class="knowledge-tags">${selected.tags.map((tag) => `<span>#${esc(tag)}</span>`).join("")}</div>` : ""}
              <pre class="knowledge-markdown">${esc(selected.content)}</pre>`
              : `<div class="empty knowledge-empty"><div class="empty-ico">${icon("book")}</div><h4>Select a note</h4><p>Its Markdown content, links and tags will appear here.</p></div>`}
          </div>
          <div class="knowledge-agents">
            <div class="knowledge-section-head"><div><strong>How agents use this library</strong><span>${esc(status.access.orchestrator)} through the Agentic OS MCP bridge</span></div><span class="badge ${status.mcp.status === "active" ? "success" : "error"}">${status.access.tools.length} tools</span></div>
            <div class="knowledge-tool-list">${status.access.tools.map((tool) => `<span class="mono">${esc(tool)}</span>`).join("")}</div>
            <div class="knowledge-usage" id="knowledgeUsage">
              ${usage.length ? usage.slice(0, 8).map((entry) => `<div class="knowledge-use-row"><span class="knowledge-use-icon">${icon(entry.action === "search" ? "search" : entry.action === "read" ? "eye" : entry.action === "list" ? "layers" : "edit")}</span><div><strong>${esc(entry.actor)}</strong><span>${esc(knowledgeAction(entry))}${entry.path ? ` · ${esc(entry.path)}` : entry.query ? ` · “${esc(entry.query)}”` : ""}</span></div><time>${timeAgo(entry.at)}</time></div>`).join("")
                : `<div class="knowledge-no-usage">No agent access recorded yet. Tool calls will appear here.</div>`}
            </div>
          </div>
        </section>
      </div>`;
    wire();
  };

  const selectNote = async (path) => {
    try {
      selected = await api.knowledge.read(path);
      usage = await api.knowledge.usage(50);
      draw();
      body.querySelector("#knowledgePreview")?.scrollTo(0, 0);
    } catch (error) { toast("error", "Obsidian", error.message); }
  };

  const load = async (nextQuery = query) => {
    query = nextQuery;
    try {
      [status, notes, usage] = await Promise.all([
        api.knowledge.status(), api.knowledge.list(query), api.knowledge.usage(50),
      ]);
      graph = await api.knowledge.graph(query);
      if (selected && !notes.some((note) => note.path === selected.path)) selected = null;
      draw();
      if (!selected && notes[0]) await selectNote(notes[0].path);
    } catch (error) {
      body.innerHTML = `<div class="alert error"><span class="a-ico">${icon("warn")}</span><div class="a-body"><div class="a-title">Obsidian library unavailable</div><div class="a-desc">${esc(error.message)}</div></div></div>`;
    }
  };

  const wire = () => {
    body.querySelectorAll("[data-note-path]").forEach((button) => {
      button.onclick = () => selectNote(button.dataset.notePath);
    });
    const search = body.querySelector("#knowledgeSearch");
    search.oninput = () => {
      clearTimeout(searchTimer);
      const value = search.value;
      searchTimer = setTimeout(() => load(value.trim()), 280);
    };
  };

  root.querySelector("#knowledgeRefresh").onclick = () => load();
  root.querySelector("#knowledgeNew").onclick = () => openModal({
    title: "New Obsidian note",
    width: 680,
    body: `<div class="field"><label class="label">Vault path</label><input class="input" id="knowledgeNewPath" placeholder="Projects/New idea.md"/></div><div class="field mt-3"><label class="label">Markdown</label><textarea class="textarea" id="knowledgeNewContent" rows="12" placeholder="# New idea\n\nWrite durable knowledge here…"></textarea></div>`,
    footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="knowledgeCreate">${icon("save")}Create note</button>`,
    onMount: (modal) => {
      modal.querySelector("#knowledgeNewPath").focus();
      modal.querySelector("#knowledgeCreate").onclick = async () => {
        const path = modal.querySelector("#knowledgeNewPath").value.trim();
        const content = modal.querySelector("#knowledgeNewContent").value;
        if (!path) return toast("error", "Obsidian", "Add a vault path");
        try {
          selected = await api.knowledge.create({ path, content });
          closeOverlay();
          toast("success", "Obsidian", `Created ${selected.path}`);
          await load();
        } catch (error) { toast("error", "Obsidian", error.message); }
      };
    },
  });
  load();
}

/* ============================ MEMORY ============================ */
export const memory = {
  title: "Memory",
  render() {
    const mems = ensure("mems", () => [
      { id: "m1", key: "user.timezone", scope: "user", value: "America/Los_Angeles", updated: Date.now() - 12e5 },
      { id: "m2", key: "project.stack", scope: "project", value: "Vanilla JS + static hosting", updated: Date.now() - 36e5 },
      { id: "m3", key: "pref.tone", scope: "user", value: "concise, technical", updated: Date.now() - 72e5 },
      { id: "m4", key: "agent.research.last_topic", scope: "agent", value: "multi-agent orchestration", updated: Date.now() - 6e5 },
    ]);
    return head("Memory", "Long-term memory shared across agents & sessions") + `
      <div class="grid cols-4" style="margin-bottom:16px">
        ${statMini("Entries", mems.length, "memory")}
        ${statMini("Vectors", "18.4K", "network")}
        ${statMini("Recall hits", "94%", "activity")}
        ${statMini("Store", "SQLite", "database")}
      </div>
      <div class="card" style="padding:0"><div class="table-wrap"><table class="tbl">
        <thead><tr><th>Key</th><th>Scope</th><th>Value</th><th>Updated</th></tr></thead>
        <tbody>${mems.map((m) => `<tr><td class="mono">${esc(m.key)}</td><td><span class="badge ${m.scope === "user" ? "info" : m.scope === "project" ? "primary" : "warning"}">${m.scope}</span></td><td class="muted">${esc(m.value)}</td><td class="muted nowrap">${timeAgo(m.updated)}</td></tr>`).join("")}</tbody>
      </table></div></div>`;
  },
};

/* ============================ MCP SERVERS ============================ */
export const mcp = {
  title: "MCP Servers",
  render() {
    const action = `<button class="btn btn-primary" id="addMcp">${icon("plus")}Add server</button>`;
    if (!api.on) {
      const list = store.state.mcpServers;
      return head("MCP Servers", "Model Context Protocol servers exposing tools over stdio", action)
        + demoNote("Start the Node backend (npm start) to spawn real MCP servers and call their tools.")
        + mcpTableHTML(list.map((m) => ({ id: m.id, name: m.name, desc: m.cmd, kind: "custom", status: m.status === "active" ? "active" : "stopped", tools: m.tools })));
    }
    return head("MCP Servers", "Spawn real MCP servers over stdio and call their tools", action)
      + `<div id="mcpBody">${loadingCard("Loading servers…")}</div>`;
  },
  mount(root) {
    if (!api.on) return mcpMountLocal(root);
    mcpMountReal(root);
  },
};

/* ============================ INTEGRATIONS ============================ */
export const integrations = {
  title: "Integrations",
  render() {
    if (!api.on) {
      const list = store.state.integrations;
      return head("Integrations", `${list.filter((i) => i.connected).length} connected`, "")
        + demoNote("Start the Node backend to make real connections (OpenAI, Anthropic, GitHub, Notion, Slack).")
        + `<div class="grid cols-3">${list.map(intCardLocal).join("")}</div>`;
    }
    return head("Integrations", "Connect services with real credential checks", "")
      + `<div id="intBody">${loadingCard("Loading integrations…")}</div>`;
  },
  mount(root) {
    if (!api.on) return intMountLocal(root);
    intMountReal(root);
  },
};

/* ============================ OBSERVABILITY ============================ */
let operationsState = null;
let operationsError = "";
let operationsLoading = false;

export const observability = {
  title: "Observability",
  render() {
    const actions = api.on ? `<div class="row gap-2"><button class="btn btn-secondary" id="opsRefresh">${icon("refresh")}Refresh</button>${api.auth.canAdmin ? `<button class="btn btn-secondary" id="opsRestoreDrill">${icon("check")}Verify restore</button><button class="btn btn-primary" id="opsBackup">${icon("database")}Create backup</button>` : ""}</div>` : "";
    if (!api.on) return head("Observability", "Server health, backups and incidents", actions) + demoNote("Start the Node backend to read host operations state.");
    if (operationsError) return head("Observability", "Server health, backups and incidents", actions) + errCard(operationsError);
    if (!operationsState) return head("Observability", "Server health, backups and incidents", actions) + loadingCard("Loading host health…");
    return head("Observability", `Last checked ${opsAge(operationsState.checkedAt)}`, actions) + operationsHTML(operationsState);
  },
  mount(root) {
    if (!api.on) return;
    root.querySelector("#opsRefresh")?.addEventListener("click", () => loadOperations(true));
    root.querySelector("#opsBackup")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.classList.add("loading");
      try {
        await api.operations.backup();
        toast("success", "Backup queued", "The host service will start it immediately.");
        [4000, 12000, 30000].forEach((delay) => setTimeout(() => loadOperations(true), delay));
      } catch (error) { toast("error", "Could not queue backup", error.message); }
      button.classList.remove("loading");
    });
    root.querySelector("#opsRestoreDrill")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.classList.add("loading");
      try {
        await api.operations.restoreDrill();
        toast("success", "Restore drill queued", "The host service will verify the latest backup safely.");
        [4000, 12000, 30000].forEach((delay) => setTimeout(() => loadOperations(true), delay));
      } catch (error) { toast("error", "Could not queue restore drill", error.message); }
      button.classList.remove("loading");
    });
    if (!operationsState && !operationsLoading) loadOperations();
  },
};

async function loadOperations(force = false) {
  if (operationsLoading && !force) return;
  operationsLoading = true;
  try { operationsState = await api.operations.status(); operationsError = ""; }
  catch (error) { operationsError = error.message || "Operations state unavailable"; }
  operationsLoading = false;
  rerender();
}

function operationsHTML(state) {
  if (!state.available) return `${fourCReadinessHTML(state.readiness)}<div class="alert warning"><span class="a-ico">${icon("warn")}</span><div class="a-body"><div class="a-title">Host monitor is not installed</div><div class="a-desc">Install the Agentic OS operations systemd units on the server to enable checks and backups.</div></div></div>`;
  const backup = state.backup || {};
  const restoreDrill = state.restoreDrill || {};
  const disk = (state.checks || []).find((check) => check.id === "disk");
  const incidents = state.incidents || [];
  return `
    ${fourCReadinessHTML(state.readiness)}
    <div class="grid cols-4 mb-4">
      ${statMini("System status", opsStatusText(state.status), state.status === "healthy" ? "check" : "warn")}
      ${statMini("Active incidents", state.activeIncidents || 0, "alert")}
      ${statMini("Last backup", opsAge(backup.lastSuccessAt), "database")}
      ${statMini("Restore verified", opsAge(restoreDrill.lastSuccessAt), "check")}
      ${statMini("Server storage", disk?.metrics?.usedPercent != null ? `${disk.metrics.usedPercent}%` : "Unknown", "database")}
    </div>
    <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(280px,1fr);margin-bottom:16px">
      <div class="card" style="padding:0"><div class="card-head" style="padding:16px 16px 0"><h3>Host checks</h3><span class="badge ${opsTone(state.status)}">${esc(opsStatusText(state.status))}</span></div><div class="table-wrap"><table class="tbl">
        <thead><tr><th>Service</th><th>Status</th><th>Detail</th><th>Checked</th></tr></thead>
        <tbody>${(state.checks || []).map((check) => `<tr><td class="fw-600">${esc(check.name)}</td><td><span class="badge ${opsTone(check.status)}"><span class="dot"></span>${esc(opsStatusText(check.status))}</span></td><td class="muted">${esc(check.detail || "")}</td><td class="muted nowrap">${opsAge(check.checkedAt)}</td></tr>`).join("")}</tbody>
      </table></div></div>
      <div class="card pad-lg"><div class="card-head"><h3>Backups</h3><span class="badge ${opsTone(backup.status)}">${esc(opsStatusText(backup.status))}</span></div>
        <div class="stack gap-3">
          ${opsFact("Last successful", opsAge(backup.lastSuccessAt))}
          ${opsFact("Archive size", opsBytes(backup.sizeBytes))}
          ${opsFact("Stored copies", String(backup.count || 0))}
          ${opsFact("Retention", `${backup.retentionDays || 14} days / ${backup.maxCount || 14} copies`)}
          ${opsFact("Daily schedule", `${state.schedule?.backupDailyAt || "03:15"} · ${state.schedule?.timezone || "server time"}`)}
        </div>
        ${backup.error ? `<div class="field-error mt-3">${esc(backup.error)}</div>` : ""}
        <div class="divider"></div>
        <div class="card-head" style="padding:0"><h3>Restore drill</h3><span class="badge ${opsTone(restoreDrill.status)}">${esc(opsStatusText(restoreDrill.status))}</span></div>
        <div class="stack gap-3 mt-3">
          ${opsFact("Last verified", opsAge(restoreDrill.lastSuccessAt))}
          ${opsFact("Files checked", String(restoreDrill.filesChecked || 0))}
          ${opsFact("Archives", Array.isArray(restoreDrill.archives) ? String(restoreDrill.archives.length) : "0")}
          ${opsFact("Backup commit", restoreDrill.gitHead ? String(restoreDrill.gitHead).slice(0, 12) : "Unknown")}
        </div>
        ${restoreDrill.error ? `<div class="field-error mt-3">${esc(restoreDrill.error)}</div>` : ""}
      </div>
    </div>
    <div class="card" style="padding:0"><div class="card-head" style="padding:16px 16px 0"><h3>Incidents</h3><span class="hint">Latest ${Math.min(incidents.length, 50)}</span></div>
      ${incidents.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Status</th><th>Check</th><th>Message</th><th>First seen</th></tr></thead><tbody>${incidents.map((incident) => `<tr><td><span class="badge ${incident.status === "resolved" ? "success" : opsTone(incident.severity)}">${esc(incident.status || "active")}</span></td><td class="fw-600">${esc(incident.name || incident.checkId)}</td><td class="muted">${esc(incident.message || "")}</td><td class="muted nowrap">${opsAge(incident.firstSeenAt)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty" style="min-height:180px"><div class="empty-ico">${icon("check")}</div><h4>No incidents recorded</h4><p>All monitored services are operating normally.</p></div>`}
    </div>`;
}

function fourCReadinessHTML(readiness) {
  if (!readiness || readiness.error) return `<div class="alert warning mb-4"><span class="a-ico">${icon("warn")}</span><div class="a-body"><div class="a-title">Four C readiness audit is unavailable</div><div class="a-desc">${esc(readiness?.error || "The server did not return an audit.")}</div></div></div>`;
  const sections = readiness.sections || [];
  const recommendations = readiness.recommendations || [];
  return `
    <div class="card pad-lg mb-4">
      <div class="card-head">
        <div><h3>Four C readiness</h3><p class="hint mt-1">Live audit of context, connections, capabilities and cadence</p></div>
        <span class="badge ${readiness.score >= 80 ? "success" : readiness.score >= 50 ? "warning" : "error"}">${esc(readiness.score)}% ready</span>
      </div>
      <div class="grid cols-4 mt-4">
        ${sections.map((section) => `
          <div class="readiness-section">
            <div class="row between gap-2"><span class="fw-700">${esc(section.label)}</span><span class="badge ${section.score >= 80 ? "success" : section.score >= 50 ? "warning" : "error"}">${esc(section.score)}%</span></div>
            <p class="hint mt-1">${esc(section.description)}</p>
            <div class="stack gap-2 mt-3">
              ${(section.checks || []).map((check) => `<div class="readiness-check ${check.ok ? "is-ready" : "needs-work"}"><span>${icon(check.ok ? "check" : "warn")}</span><div><div class="text-sm fw-600">${esc(check.label)}</div><div class="hint">${esc(check.detail)}</div></div></div>`).join("")}
            </div>
          </div>`).join("")}
      </div>
      ${recommendations.length ? `<div class="readiness-actions mt-4"><div class="fw-700 mb-3">Next operational actions</div><div class="grid cols-2">${recommendations.map((item) => `<a class="readiness-action" href="${esc(item.href)}"><div><span class="eyebrow">${esc(item.section)}</span><div class="fw-600 mt-1">${esc(item.title)}</div><div class="hint mt-1">${esc(item.detail)}</div></div>${icon("arrowright")}</a>`).join("")}</div></div>` : `<div class="alert success mt-4"><span class="a-ico">${icon("check")}</span><div class="a-body"><div class="a-title">All operational layers are ready</div><div class="a-desc">No readiness gaps were detected.</div></div></div>`}
    </div>`;
}

function opsFact(label, value) {
  return `<div class="row between" style="padding-bottom:10px;border-bottom:1px solid var(--border)"><span class="muted">${esc(label)}</span><span class="fw-600">${esc(value)}</span></div>`;
}
function opsTone(status) { return status === "healthy" || status === "success" ? "success" : status === "critical" || status === "error" ? "error" : status === "degraded" || status === "running" ? "warning" : "neutral"; }
function opsStatusText(status) { return ({ healthy: "Healthy", degraded: "Degraded", critical: "Critical", success: "Protected", running: "Running", error: "Failed", unknown: "Unknown" })[status] || status || "Unknown"; }
function opsAge(value) { const stamp = value ? new Date(value).getTime() : NaN; return Number.isFinite(stamp) ? timeAgo(stamp) : "Never"; }
function opsBytes(value) { if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "Unknown"; const units = ["B", "KB", "MB", "GB", "TB"]; let amount = Number(value), index = 0; while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; } return `${amount.toFixed(index ? 1 : 0)} ${units[index]}`; }

/* ============================ GUARDRAILS ============================ */
export const guardrails = {
  title: "Guardrails",
  render() {
    const rules = ensure("guards", () => [
      { id: "g1", name: "PII redaction", desc: "Mask emails, phone numbers and SSNs in I/O", on: true },
      { id: "g2", name: "Toxicity filter", desc: "Block toxic or unsafe generations", on: true },
      { id: "g3", name: "Prompt-injection shield", desc: "Ignore instructions found in tool output", on: true },
      { id: "g4", name: "Rate limiting", desc: "Cap requests per agent per minute", on: false },
      { id: "g5", name: "Allowed tools only", desc: "Restrict agents to an approved tool list", on: true },
      { id: "g6", name: "Human approval", desc: "Require approval for irreversible actions", on: false },
    ]);
    return head("Guardrails", `${rules.filter((r) => r.on).length} of ${rules.length} active`) + `
      <div class="grid cols-2">
        ${rules.map((r) => `<div class="card"><div class="row between"><div class="row gap-3"><div class="aico" style="background:${store.colors.green}">${icon("shield")}</div><div class="stack"><span class="fw-700">${r.name}</span><span class="hint">${r.desc}</span></div></div><label class="switch"><input type="checkbox" data-guard="${r.id}" ${r.on ? "checked" : ""}/><span class="track"></span><span class="thumb"></span></label></div></div>`).join("")}
      </div>`;
  },
  mount(root) {
    root.querySelectorAll("[data-guard]").forEach((c) => (c.onchange = () => {
      store.set((s) => (s.guards.find((r) => r.id === c.dataset.guard).on = c.checked));
      toast(c.checked ? "success" : "info", "Guardrail " + (c.checked ? "enabled" : "disabled"));
    }));
  },
};

/* ============================ SECRETS ============================ */
export const secrets = {
  title: "Secrets",
  render() {
    const list = ensure("secrets_", () => [
      { id: "s1", name: "OPENAI_API_KEY", updated: Date.now() - 8e6 },
      { id: "s2", name: "SLACK_WEBHOOK_URL", updated: Date.now() - 26e6 },
      { id: "s3", name: "POSTGRES_URL", updated: Date.now() - 5e6 },
    ]);
    return head("Secrets", "Encrypted credentials available to your agents", `<button class="btn btn-primary" id="addSecret">${icon("plus")}Add secret</button>`) + `
      <div class="alert info mb-4"><span class="a-ico">${icon("lock")}</span><div class="a-body"><div class="a-title">Values are write-only</div><div class="a-desc">For your safety this demo never displays secret values. In production, store them in an encrypted vault.</div></div></div>
      <div class="card" style="padding:0"><div class="table-wrap"><table class="tbl">
        <thead><tr><th>Name</th><th>Value</th><th>Updated</th><th></th></tr></thead>
        <tbody>${list.map((s) => `<tr><td class="mono fw-600">${esc(s.name)}</td><td class="mono muted">•••••••••••••</td><td class="muted nowrap">${timeAgo(s.updated)}</td><td><button class="btn sm btn-ghost" data-del-secret="${s.id}" style="color:var(--error)">${icon("trash")}</button></td></tr>`).join("")}</tbody>
      </table></div></div>`;
  },
  mount(root) {
    root.querySelectorAll("[data-del-secret]").forEach((b) => (b.onclick = () => confirmDialog({ title: "Delete secret", message: "Remove this secret? Agents relying on it will fail.", confirmText: "Delete", onConfirm: () => { store.set((s) => (s.secrets_ = s.secrets_.filter((x) => x.id !== b.dataset.delSecret))); toast("success", "Secret deleted"); rerender(); } })));
    const add = root.querySelector("#addSecret");
    if (add) add.onclick = () => openModal({
      title: "Add secret", width: 460,
      body: `<div class="field"><label class="label">Name</label><input class="input mono" id="sn" placeholder="MY_API_KEY"/></div><div class="field"><label class="label">Value</label><input class="input mono" id="sv" type="password" placeholder="••••••••"/><span class="hint">Stored write-only in this demo.</span></div>`,
      footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="sok">${icon("lock")}Save secret</button>`,
      onMount: (m) => (m.querySelector("#sok").onclick = () => { const n = m.querySelector("#sn").value.trim(); if (!n) return toast("error", "Name required"); store.set((s) => s.secrets_.push({ id: store.uid(), name: n, updated: Date.now() })); closeOverlay(); toast("success", "Secret saved", n); rerender(); }),
    });
  },
};

/* ============================ EVALUATIONS ============================ */
export const evaluations = {
  title: "Evaluations",
  render() {
    const runs = [
      { id: "e1", name: "Research quality", agent: "Research Agent", score: 96, pass: true, cases: 120, at: Date.now() - 3e6 },
      { id: "e2", name: "Answer faithfulness", agent: "Support Agent", score: 92, pass: true, cases: 200, at: Date.now() - 8e6 },
      { id: "e3", name: "Code correctness", agent: "Code Reviewer", score: 78, pass: false, cases: 64, at: Date.now() - 12e6 },
      { id: "e4", name: "Tone & style", agent: "Content Writer", score: 88, pass: true, cases: 90, at: Date.now() - 20e6 },
    ];
    return head("Evaluations", "Automated quality scoring for your agents", `<button class="btn btn-primary">${icon("play")}Run eval</button>`) + `
      <div class="grid cols-4" style="margin-bottom:16px">
        ${statMini("Avg score", "88.5", "evaluations")}
        ${statMini("Pass rate", "75%", "check")}
        ${statMini("Eval cases", "474", "layers")}
        ${statMini("Regressions", "1", "down")}
      </div>
      <div class="grid" style="grid-template-columns:1fr 2fr">
        <div class="card pad-lg"><div class="card-head"><h3>Score trend</h3></div><div style="display:grid;place-items:center;padding:8px">${ring(88, 120, 12)}</div><div class="row between text-sm muted mt-4"><span>Last 30 runs</span><span class="badge success">▲ 3.2</span></div></div>
        <div class="card" style="padding:0"><div class="card-head" style="padding:16px 16px 0"><h3>Recent runs</h3></div><div class="table-wrap"><table class="tbl">
          <thead><tr><th>Eval</th><th>Agent</th><th>Cases</th><th>Score</th><th>Result</th><th>When</th></tr></thead>
          <tbody>${runs.map((r) => `<tr><td class="fw-600">${esc(r.name)}</td><td class="muted">${esc(r.agent)}</td><td class="mono">${r.cases}</td><td><div class="row gap-2">${r.score}<span class="meter"><span style="width:${r.score}%;background:${r.pass ? "var(--success)" : "var(--error)"}"></span></span></div></td><td>${r.pass ? statusBadge("completed") : `<span class="badge error"><span class="dot"></span>Failed</span>`}</td><td class="muted nowrap">${timeAgo(r.at)}</td></tr>`).join("")}</tbody>
        </table></div></div>
      </div>`;
  },
};

/* ---------- shared mini stat ---------- */
function statMini(label, value, ic) {
  return `<div class="stat"><div class="stat-top"><span class="stat-label">${label}</span><span class="stat-ico">${icon(ic)}</span></div><div class="stat-value" style="font-size:26px">${value}</div></div>`;
}

/* ============================================================
   Backend-aware helpers (MCP + Integrations)
   ============================================================ */
function demoNote(txt) {
  return `<div class="alert info mb-4"><span class="a-ico">${icon("info")}</span><div class="a-body"><div class="a-title">Demo mode — no backend</div><div class="a-desc">${esc(txt)}</div></div></div>`;
}
function loadingCard(txt) {
  return `<div class="card"><div class="row gap-2"><div class="spinner"></div><span class="muted">${esc(txt)}</span></div></div>`;
}
function errCard(msg) {
  return `<div class="alert error"><span class="a-ico">${icon("x")}</span><div class="a-body"><div class="a-title">Request failed</div><div class="a-desc">${esc(msg)}</div></div></div>`;
}

/* ---- MCP ---- */
function mcpRowHTML(m) {
  const count = Array.isArray(m.tools) ? m.tools.length : (m.tools || 0);
  const active = m.status === "active";
  const badge = active ? `<span class="badge success"><span class="dot"></span>Active</span>`
    : m.status === "error" ? `<span class="badge error"><span class="dot"></span>Error</span>`
    : `<span class="badge neutral">Stopped</span>`;
  return `<tr>
    <td><div class="cell-main"><div class="aico" style="background:${store.colors.blue};width:30px;height:30px">${icon("mcp")}</div><div class="stack"><span class="fw-600">${esc(m.name)}</span><span class="cell-sub">${esc(m.desc || m.kind || "")}</span></div></div></td>
    <td>${badge}</td>
    <td class="mono">${count}</td>
    <td><div class="row gap-2">
      ${active ? `<button class="btn sm btn-secondary" data-mcpstop="${m.id}">Stop</button>` : `<button class="btn sm btn-primary" data-mcpstart="${m.id}">Start</button>`}
      ${active && count ? `<button class="btn sm btn-ghost" data-mcptools="${m.id}">${icon("tools")}Tools</button>` : ""}
      ${m.kind === "custom" ? `<button class="icon-btn" data-mcpdel="${m.id}" title="Delete">${icon("trash")}</button>` : ""}
    </div></td>
  </tr>`;
}
function mcpTableHTML(rows) {
  return `<div class="card" style="padding:0"><div class="table-wrap"><table class="tbl"><thead><tr><th>Server</th><th>Status</th><th>Tools</th><th>Actions</th></tr></thead><tbody id="mcpRows">${rows.map(mcpRowHTML).join("")}</tbody></table></div></div>`;
}
async function mcpMountReal(root) {
  const body = root.querySelector("#mcpBody");
  let servers = [];
  try { servers = await api.mcp.list(); } catch (e) { body.innerHTML = errCard(e.message); return; }
  body.innerHTML = mcpTableHTML(servers);
  root.querySelectorAll("[data-mcpstart]").forEach((b) => (b.onclick = async () => {
    b.classList.add("loading");
    try { const r = await api.mcp.connect(b.dataset.mcpstart); toast("success", "Server started", (r.tools?.length || 0) + " tools discovered"); }
    catch (e) { toast("error", "Start failed", e.message); }
    rerender();
  }));
  root.querySelectorAll("[data-mcpstop]").forEach((b) => (b.onclick = async () => {
    try { await api.mcp.disconnect(b.dataset.mcpstop); toast("info", "Server stopped"); } catch (e) { toast("error", "Stop failed", e.message); }
    rerender();
  }));
  root.querySelectorAll("[data-mcpdel]").forEach((b) => (b.onclick = () => confirmDialog({
    title: "Delete MCP server", message: "Remove this server definition?", confirmText: "Delete",
    onConfirm: async () => { try { await api.mcp.remove(b.dataset.mcpdel); toast("success", "Server removed"); rerender(); } catch (e) { toast("error", "Failed", e.message); } },
  })));
  root.querySelectorAll("[data-mcptools]").forEach((b) => (b.onclick = () => openToolRunner(servers.find((s) => s.id === b.dataset.mcptools))));
  wireAddMcp(root, true);
}
function openToolRunner(server) {
  const tools = server.tools || [];
  openModal({
    title: "Run tool · " + server.name, width: 540,
    body: `<div class="field"><label class="label">Tool</label><select class="select" id="trTool">${tools.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}${t.description ? " — " + esc(t.description) : ""}</option>`).join("")}</select></div>
      <div class="field"><label class="label">Arguments (JSON)</label><textarea class="textarea mono" id="trArgs" rows="3">{}</textarea></div>
      <div id="trResult"></div>`,
    footer: `<button class="btn btn-secondary" data-close>Close</button><button class="btn btn-primary" id="trRun">${icon("play")}Run</button>`,
    onMount: (m) => (m.querySelector("#trRun").onclick = async () => {
      let args = {};
      try { args = JSON.parse(m.querySelector("#trArgs").value || "{}"); } catch { return toast("error", "Arguments must be valid JSON"); }
      const btn = m.querySelector("#trRun"); btn.classList.add("loading");
      try {
        const r = await api.mcp.call(server.id, m.querySelector("#trTool").value, args);
        const text = (r.result?.content || []).map((c) => c.text).filter(Boolean).join("\n");
        m.querySelector("#trResult").innerHTML = `<div class="section-title">Result</div><div class="codeblock"><pre>${esc(text || JSON.stringify(r.result, null, 2))}</pre></div>`;
      } catch (e) { toast("error", "Call failed", e.message); }
      btn.classList.remove("loading");
    }),
  });
}
function wireAddMcp(root, real) {
  const add = root.querySelector("#addMcp");
  if (!add) return;
  add.onclick = () => openModal({
    title: "Add MCP server", width: 540,
    body: `<div class="field"><label class="label">Name</label><input class="input" id="mn" placeholder="my-server"/></div>
      <div class="field"><label class="label">Command</label><input class="input mono" id="mcmd" placeholder="npx"/></div>
      <div class="field"><label class="label">Arguments (space-separated)</label><input class="input mono" id="marg" placeholder="-y @modelcontextprotocol/server-filesystem ."/></div>`,
    footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="mok">${icon("plus")}Add server</button>`,
    onMount: (m) => (m.querySelector("#mok").onclick = async () => {
      const name = m.querySelector("#mn").value.trim(), command = m.querySelector("#mcmd").value.trim();
      if (!name || !command) return toast("error", "Name and command required");
      const args = m.querySelector("#marg").value.trim();
      try {
        if (real) await api.mcp.add({ name, command, args });
        else store.set((s) => s.mcpServers.push({ id: store.uid(), name, cmd: command + " " + args, status: "idle", tools: 0 }));
        closeOverlay(); toast("success", "Server added", name); rerender();
      } catch (e) { toast("error", "Add failed", e.message); }
    }),
  });
}
function mcpMountLocal(root) {
  const view = root.closest ? root : root;
  root.querySelectorAll("[data-mcpstart],[data-mcpstop]").forEach((b) => {
    const id = b.dataset.mcpstart || b.dataset.mcpstop;
    b.onclick = () => { store.set((s) => { const m = s.mcpServers.find((x) => x.id === id); m.status = m.status === "active" ? "idle" : "active"; }); rerender(); };
  });
  root.querySelectorAll("[data-mcpdel]").forEach((b) => (b.onclick = () => { store.set((s) => (s.mcpServers = s.mcpServers.filter((x) => x.id !== b.dataset.mcpdel))); rerender(); }));
  wireAddMcp(root, false);
}

/* ---- Integrations ---- */
function intCardLocal(i) {
  return `<div class="card tile"><div class="row between"><div class="row gap-3"><div class="aico" style="background:${store.colors[i.color]}">${icon(i.icon)}</div><div class="stack"><span class="fw-700">${esc(i.name)}</span><span class="hint">${esc(i.desc)}</span></div></div></div>
    <div class="row between mt-4">${i.connected ? `<span class="badge success"><span class="dot"></span>Connected</span>` : `<span class="badge neutral">Not connected</span>`}<button class="btn sm ${i.connected ? "btn-secondary" : "btn-primary"}" data-int="${i.id}">${i.connected ? "Disconnect" : "Connect"}</button></div></div>`;
}
function intMountLocal(root) {
  root.querySelectorAll("[data-int]").forEach((b) => (b.onclick = () => {
    const i = store.state.integrations.find((x) => x.id === b.dataset.int);
    store.set((s) => (s.integrations.find((x) => x.id === b.dataset.int).connected = !i.connected));
    toast(i.connected ? "info" : "success", (i.connected ? "Disconnected " : "Connected ") + i.name); rerender();
  }));
}
function intCardReal(i) {
  return `<div class="card tile" data-intcard="${i.provider}"><div class="row between"><div class="row gap-3"><div class="aico" style="background:${store.colors[i.color] || store.colors.violet}">${icon(i.icon)}</div><div class="stack"><span class="fw-700">${esc(i.name)}</span><span class="hint">${esc(i.desc)}</span></div></div></div>
    ${i.lastResult ? `<div class="hint mt-2">${i.lastResult.ok ? "✓" : "✕"} ${esc(i.lastResult.detail || "")}</div>` : ""}
    <div class="row between mt-4">${i.connected ? `<span class="badge success"><span class="dot"></span>Connected</span>` : `<span class="badge neutral">Not connected</span>`}
      <div class="row gap-2">${i.connected && i.provider === "slack" ? `<button class="btn sm btn-ghost" data-intsend="${i.provider}">Send test</button>` : ""}${i.connected && i.provider === "mila" ? `<button class="btn sm btn-ghost" data-intstatus="mila">Status</button><button class="btn sm btn-ghost" data-intdevices="mila">Devices</button><button class="btn sm btn-primary" data-intcode="mila">New code</button>` : ""}<button class="btn sm ${i.connected ? "btn-secondary" : "btn-primary"}" data-intbtn="${i.provider}">${i.connected ? "Disconnect" : "Connect"}</button></div>
    </div></div>`;
}
async function intMountReal(root) {
  const body = root.querySelector("#intBody");
  let list = [];
  try { list = await api.integrations.list(); } catch (e) { body.innerHTML = errCard(e.message); return; }
  body.innerHTML = `<div class="grid cols-3">${list.map(intCardReal).join("")}</div>`;
  list.forEach((i) => {
    const card = body.querySelector(`[data-intcard="${i.provider}"]`); if (!card) return;
    card.querySelector("[data-intbtn]").onclick = () => (i.connected ? intDisconnect(i) : intConnect(i));
    const send = card.querySelector("[data-intsend]");
    if (send) send.onclick = async () => { try { await api.integrations.slackSend("Test message from Agentic OS ✅"); toast("success", "Sent to Slack"); } catch (e) { toast("error", "Send failed", e.message); } };
    const status = card.querySelector("[data-intstatus]");
    if (status) status.onclick = async () => {
      try {
        const s = await api.integrations.milaStatus();
        toast(s.voiceConfigured ? "success" : "info", "MILA Voice", s.voiceConfigured ? `Ready · ${s.liveModel}` : "Backend online · Gemini key missing");
      } catch (e) { toast("error", "MILA status failed", e.message); }
    };
    const code = card.querySelector("[data-intcode]");
    if (code) code.onclick = () => openMilaCode();
    const devices = card.querySelector("[data-intdevices]");
    if (devices) devices.onclick = () => openMilaDevices();
  });
}
function openMilaCode() {
  openModal({
    title: "Connect MILA mobile app", width: 460,
    body: `<div class="field"><label class="label">Account label</label><input class="input" id="milaLabel" placeholder="Name or email"/></div><div id="milaCodeResult" class="mt-3"></div>`,
    footer: `<button class="btn btn-secondary" data-close>Close</button><button class="btn btn-primary" id="milaCreateCode">Create one-time code</button>`,
    onMount: (m) => (m.querySelector("#milaCreateCode").onclick = async () => {
      const btn = m.querySelector("#milaCreateCode"); btn.classList.add("loading");
      try {
        const result = await api.integrations.milaConnectionCode(m.querySelector("#milaLabel").value.trim() || "MILA user");
        m.querySelector("#milaCodeResult").innerHTML = `<div class="alert success"><span class="a-ico">${icon("key")}</span><div class="a-body"><div class="a-title mono" style="font-size:22px;letter-spacing:3px">${esc(result.code)}</div><div class="a-desc">Enter in MILA → Settings → AI Providers. Expires in 10 minutes.</div></div></div>`;
      } catch (e) { m.querySelector("#milaCodeResult").innerHTML = `<div class="alert error"><span class="a-ico">${icon("x")}</span><div class="a-body"><div class="a-title">Could not create code</div><div class="a-desc">${esc(e.message)}</div></div></div>`; }
      btn.classList.remove("loading");
    }),
  });
}
function milaDeviceTime(value) {
  if (!value) return "Unknown time";
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}
function openMilaDevices() {
  openModal({
    title: "MILA mobile devices", width: 620,
    body: `<div id="milaDevicesList" class="stack gap-2"><div class="hint">Loading devices…</div></div>`,
    footer: `<button class="btn btn-secondary" data-close>Close</button>`,
    onMount: async (m) => {
      const slot = m.querySelector("#milaDevicesList");
      const render = (devices) => {
        if (!devices.length) { slot.innerHTML = `<div class="empty">No MILA devices have been paired yet.</div>`; return; }
        slot.innerHTML = devices.map((device) => `<div class="card tile"><div class="row between gap-3"><div class="stack"><strong>${esc(device.label || "MILA device")}</strong><span class="hint">Paired ${esc(milaDeviceTime(device.createdAt))}</span>${device.revokedAt ? `<span class="hint">Revoked ${esc(milaDeviceTime(device.revokedAt))}</span>` : ""}</div><div class="row gap-2"><span class="badge ${device.active ? "success" : "neutral"}">${device.active ? "Active" : "Revoked"}</span>${device.active ? `<button class="btn sm btn-secondary" data-mila-revoke="${esc(device.id)}">Revoke</button>` : ""}</div></div></div>`).join("");
        slot.querySelectorAll("[data-mila-revoke]").forEach((button) => {
          button.onclick = async () => {
            if (!window.confirm("Revoke this MILA device? It will need a new one-time code to reconnect.")) return;
            button.classList.add("loading");
            try { await api.integrations.milaRevokeDevice(button.dataset.milaRevoke); const result = await api.integrations.milaDevices(); render(result.devices || []); toast("success", "MILA device revoked"); }
            catch (error) { toast("error", "Could not revoke device", error.message); }
            finally { button.classList.remove("loading"); }
          };
        });
      };
      try { const result = await api.integrations.milaDevices(); render(result.devices || []); }
      catch (error) { slot.innerHTML = `<div class="alert error"><span class="a-ico">${icon("x")}</span><div class="a-body"><div class="a-title">Could not load devices</div><div class="a-desc">${esc(error.message)}</div></div></div>`; }
    },
  });
}
function intConnect(i) {
  openModal({
    title: "Connect " + i.name, width: 480,
    body: (i.fields || []).map((f) => `<div class="field"><label class="label">${esc(f.label)}</label><input class="input mono" id="if_${f.key}" ${f.secret ? 'type="password"' : ""} placeholder="${esc(f.label)}"/></div>`).join("") + `<div id="icErr"></div>`,
    footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="icOk">${icon("lock")}Connect &amp; test</button>`,
    onMount: (m) => (m.querySelector("#icOk").onclick = async () => {
      const cfg = {}; (i.fields || []).forEach((f) => (cfg[f.key] = m.querySelector("#if_" + f.key).value.trim()));
      const btn = m.querySelector("#icOk"); btn.classList.add("loading");
      try {
        const r = await api.integrations.connect(i.provider, cfg);
        if (r.ok) { closeOverlay(); toast("success", "Connected " + i.name, r.detail); rerender(); }
        else m.querySelector("#icErr").innerHTML = `<div class="alert error"><span class="a-ico">${icon("x")}</span><div class="a-body"><div class="a-title">Connection failed</div><div class="a-desc">${esc(r.detail)}</div></div></div>`;
      } catch (e) { toast("error", "Error", e.message); }
      btn.classList.remove("loading");
    }),
  });
}
async function intDisconnect(i) {
  try { await api.integrations.disconnect(i.provider); toast("info", "Disconnected " + i.name); rerender(); }
  catch (e) { toast("error", "Failed", e.message); }
}
