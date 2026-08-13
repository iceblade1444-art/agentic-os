import { store, timeAgo } from "../store.js";
import { icon } from "../icons.js";
import { esc, toast, statusBadge, lineChart, donut, bars, ring, randomSeries, agentIcon, confirmDialog, openModal, closeOverlay } from "../ui.js";
import { api } from "../api.js";
import { t } from "../i18n.js";

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
let memoryState = null;
let memoryError = "";
let memoryLoading = false;

const JOURNAL_KIND_ICONS = {
  task: "evaluations", note: "file", reminder: "clock", calendar: "calendar",
  kanban: "grid", hermes: "bot", vault: "knowledge", claude: "code",
  erp: "database", mcp: "mcp", mission: "rocket", routine: "refresh",
};

// The day journal is the half of memory the system writes itself, so it is shown
// as a timeline rather than a table: what happened, in order, newest first.
function journalHTML(entries) {
  if (!entries.length) {
    return `<div class="card pad-lg mb-4"><div class="empty" style="min-height:150px">
      <div class="empty-ico">${icon("activity")}</div>
      <h4>${t("memory.journalEmpty")}</h4><p>${t("memory.journalEmptyText")}</p>
    </div></div>`;
  }
  let lastDate = "";
  const rows = entries.map((item) => {
    const heading = item.date === lastDate ? "" : `<div class="memory-journal-day">${esc(item.date)}</div>`;
    lastDate = item.date;
    return `${heading}<div class="memory-journal-row">
      <span class="memory-journal-time mono">${esc(item.time || "—")}</span>
      <span class="memory-journal-ico">${icon(JOURNAL_KIND_ICONS[item.kind] || "dot")}</span>
      <span class="memory-journal-body"><strong>${esc(item.title)}</strong>${item.detail ? `<small>${esc(item.detail)}</small>` : ""}</span>
      ${item.actor ? `<span class="badge neutral">${esc(item.actor)}</span>` : ""}
    </div>`;
  }).join("");
  return `<div class="card mb-4" style="padding:0">
    <div class="memory-journal-head"><h4>${t("memory.journalTitle")}</h4><span>${t("memory.journalSub")}</span></div>
    <div class="memory-journal">${rows}</div>
  </div>`;
}

export const memory = {
  title: "Memory",
  render() {
    const action = `<button class="btn btn-secondary" id="memoryRefresh">${icon("refresh")}${t("system.refresh")}</button>`;
    if (!api.on) return head(t("memory.title"), t("memory.serverContext")) + demoNote(t("memory.backendRequired"));
    if (memoryError) return head(t("memory.title"), t("memory.serverContext"), action) + errCard(memoryError);
    if (!memoryState) return head(t("memory.title"), t("memory.serverContext"), action) + loadingCard(t("memory.loading"));
    const mems = memoryState.entries || [];
    const stats = memoryState.stats || {};
    return head(t("memory.title"), t("memory.subtitle"), action) + `
      <div class="grid cols-4" style="margin-bottom:16px">
        ${statMini(t("memory.visibleEntries"), stats.entries || 0, "memory")}
        ${statMini(t("memory.journalEntries"), stats.journalEntries || 0, "activity")}
        ${statMini(t("memory.personalNotes"), stats.personalNotes || 0, "file")}
        ${statMini(t("memory.obsidianNotes"), stats.vaultNotes || 0, "knowledge")}
      </div>
      <div class="alert info mb-4"><span class="a-ico">${icon("database")}</span><div class="a-body"><div class="a-title">${t("memory.authoritative")}</div><div class="a-desc">${t("memory.authoritativeText")}</div></div></div>
      ${journalHTML(memoryState.journal || [])}
      <div class="card" style="padding:0"><div class="table-wrap"><table class="tbl">
        <thead><tr><th>${t("memory.key")}</th><th>${t("memory.scope")}</th><th>${t("memory.value")}</th><th>${t("memory.source")}</th><th>${t("system.updated")}</th></tr></thead>
        <tbody>${mems.length ? mems.map((item) => `<tr><td class="mono">${esc(item.key)}</td><td><span class="badge ${item.scope === "user" ? "info" : item.scope === "workspace" ? "primary" : "warning"}">${esc(t(`memory.scope.${item.scope}`))}</span></td><td class="muted">${esc(item.value)}</td><td><span class="badge neutral">${esc(item.source)}</span></td><td class="muted nowrap">${item.updatedAt ? timeAgo(new Date(item.updatedAt).getTime()) : "—"}</td></tr>`).join("") : `<tr><td colspan="5"><div class="empty" style="min-height:180px"><div class="empty-ico">${icon("memory")}</div><h4>${t("memory.empty")}</h4><p>${t("memory.emptyText")}</p></div></td></tr>`}</tbody>
      </table></div></div>`;
  },
  mount(root) {
    if (!api.on) return;
    root.querySelector("#memoryRefresh")?.addEventListener("click", () => loadMemory(true));
    if (!memoryState && !memoryLoading) loadMemory();
  },
};

async function loadMemory(force = false) {
  if (memoryLoading && !force) return;
  memoryLoading = true;
  try { memoryState = await api.memory.snapshot(); memoryError = ""; }
  catch (error) { memoryError = error.message || "Memory unavailable"; }
  memoryLoading = false;
  rerender();
}

/* ============================ MCP SERVERS ============================ */
export const mcp = {
  title: t("mcp.title"),
  render() {
    const action = `<button class="btn btn-primary" id="addMcp">${icon("plus")}${t("mcp.add")}</button>`;
    if (!api.on) {
      const list = store.state.mcpServers;
      return head(t("mcp.title"), t("mcp.subtitle"), action)
        + demoNote(t("mcp.demo"))
        + mcpTableHTML(list.map((m) => ({ id: m.id, name: m.name, desc: m.cmd, kind: "custom", status: m.status === "active" ? "active" : "stopped", tools: m.tools })));
    }
    return head(t("mcp.title"), t("mcp.realSubtitle"), action)
      + `<div id="mcpBody">${loadingCard(t("mcp.loading"))}</div>`;
  },
  mount(root) {
    if (!api.on) return mcpMountLocal(root);
    mcpMountReal(root);
  },
};

/* ============================ INTEGRATIONS ============================ */
export const integrations = {
  title: t("integrations.title"),
  render() {
    if (!api.on) {
      const list = store.state.integrations;
      return head(t("integrations.title"), t("integrations.connectedCount", { count: list.filter((i) => i.connected).length }), "")
        + demoNote(t("integrations.demo"))
        + `<div class="grid cols-3">${list.map(intCardLocal).join("")}</div>`;
    }
    return head(t("integrations.title"), t("integrations.subtitle"), "")
      + `<div id="intBody">${loadingCard(t("integrations.loading"))}</div>`;
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
  title: t("operations.title"),
  render() {
    const actions = api.on ? `<div class="row gap-2"><button class="btn btn-secondary" id="opsRefresh">${icon("refresh")}${t("system.refresh")}</button>${api.auth.canAdmin ? `<button class="btn btn-secondary" id="opsRestoreDrill">${icon("check")}${t("operations.verifyRestore")}</button><button class="btn btn-primary" id="opsBackup">${icon("database")}${t("operations.createBackup")}</button>` : ""}</div>` : "";
    if (!api.on) return head(t("operations.title"), t("operations.subtitle"), actions) + demoNote(t("operations.demo"));
    if (operationsError) return head(t("operations.title"), t("operations.subtitle"), actions) + errCard(operationsError);
    if (!operationsState) return head(t("operations.title"), t("operations.subtitle"), actions) + loadingCard(t("operations.loading"));
    return head(t("operations.title"), t("operations.lastChecked", { value: opsAge(operationsState.checkedAt) }), actions) + operationsHTML(operationsState);
  },
  mount(root) {
    if (!api.on) return;
    root.querySelector("#opsRefresh")?.addEventListener("click", () => loadOperations(true));
    root.querySelector("#opsBackup")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.classList.add("loading");
      try {
        await api.operations.backup();
        toast("success", t("operations.backupQueued"), t("operations.backupQueuedText"));
        [4000, 12000, 30000].forEach((delay) => setTimeout(() => loadOperations(true), delay));
      } catch (error) { toast("error", t("operations.backupFailed"), error.message); }
      button.classList.remove("loading");
    });
    root.querySelector("#opsRestoreDrill")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.classList.add("loading");
      try {
        await api.operations.restoreDrill();
        toast("success", t("operations.restoreQueued"), t("operations.restoreQueuedText"));
        [4000, 12000, 30000].forEach((delay) => setTimeout(() => loadOperations(true), delay));
      } catch (error) { toast("error", t("operations.restoreFailed"), error.message); }
      button.classList.remove("loading");
    });
    if (!operationsState && !operationsLoading) loadOperations();
  },
};

async function loadOperations(force = false) {
  if (operationsLoading && !force) return;
  operationsLoading = true;
  try { operationsState = await api.operations.status(); operationsError = ""; }
  catch (error) { operationsError = error.message || t("operations.unavailable"); }
  operationsLoading = false;
  rerender();
}

function operationsHTML(state) {
  if (!state.available) return `${fourCReadinessHTML(state.readiness)}<div class="alert warning"><span class="a-ico">${icon("warn")}</span><div class="a-body"><div class="a-title">${t("operations.monitorMissing")}</div><div class="a-desc">${t("operations.monitorMissingText")}</div></div></div>`;
  const backup = state.backup || {};
  const restoreDrill = state.restoreDrill || {};
  const disk = (state.checks || []).find((check) => check.id === "disk");
  const incidents = state.incidents || [];
  return `
    ${fourCReadinessHTML(state.readiness)}
    <div class="grid cols-4 mb-4">
      ${statMini(t("operations.systemStatus"), opsStatusText(state.status), state.status === "healthy" ? "check" : "warn")}
      ${statMini(t("operations.activeIncidents"), state.activeIncidents || 0, "alert")}
      ${statMini(t("operations.lastBackup"), opsAge(backup.lastSuccessAt), "database")}
      ${statMini(t("operations.restoreVerified"), opsAge(restoreDrill.lastSuccessAt), "check")}
      ${statMini(t("operations.serverStorage"), disk?.metrics?.usedPercent != null ? `${disk.metrics.usedPercent}%` : t("operations.unknown"), "database")}
    </div>
    <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(280px,1fr);margin-bottom:16px">
      <div class="card" style="padding:0"><div class="card-head" style="padding:16px 16px 0"><h3>${t("operations.hostChecks")}</h3><span class="badge ${opsTone(state.status)}">${esc(opsStatusText(state.status))}</span></div><div class="table-wrap"><table class="tbl">
        <thead><tr><th>${t("operations.service")}</th><th>${t("system.status")}</th><th>${t("operations.detail")}</th><th>${t("operations.checked")}</th></tr></thead>
        <tbody>${(state.checks || []).map((check) => `<tr><td class="fw-600">${esc(check.name)}</td><td><span class="badge ${opsTone(check.status)}"><span class="dot"></span>${esc(opsStatusText(check.status))}</span></td><td class="muted">${esc(check.detail || "")}</td><td class="muted nowrap">${opsAge(check.checkedAt)}</td></tr>`).join("")}</tbody>
      </table></div></div>
      <div class="card pad-lg"><div class="card-head"><h3>${t("operations.backups")}</h3><span class="badge ${opsTone(backup.status)}">${esc(opsStatusText(backup.status))}</span></div>
        <div class="stack gap-3">
          ${opsFact(t("operations.lastSuccessful"), opsAge(backup.lastSuccessAt))}
          ${opsFact(t("operations.archiveSize"), opsBytes(backup.sizeBytes))}
          ${opsFact(t("operations.storedCopies"), String(backup.count || 0))}
          ${opsFact(t("operations.retention"), t("operations.retentionValue", { days: backup.retentionDays || 14, copies: backup.maxCount || 14 }))}
          ${opsFact(t("operations.dailySchedule"), `${state.schedule?.backupDailyAt || "03:15"} · ${state.schedule?.timezone || t("operations.serverTime")}`)}
        </div>
        ${backup.error ? `<div class="field-error mt-3">${esc(backup.error)}</div>` : ""}
        <div class="divider"></div>
        <div class="card-head" style="padding:0"><h3>${t("operations.restoreDrill")}</h3><span class="badge ${opsTone(restoreDrill.status)}">${esc(opsStatusText(restoreDrill.status))}</span></div>
        <div class="stack gap-3 mt-3">
          ${opsFact(t("operations.lastVerified"), opsAge(restoreDrill.lastSuccessAt))}
          ${opsFact(t("operations.filesChecked"), String(restoreDrill.filesChecked || 0))}
          ${opsFact(t("operations.archives"), Array.isArray(restoreDrill.archives) ? String(restoreDrill.archives.length) : "0")}
          ${opsFact(t("operations.backupCommit"), restoreDrill.gitHead ? String(restoreDrill.gitHead).slice(0, 12) : t("operations.unknown"))}
        </div>
        ${restoreDrill.error ? `<div class="field-error mt-3">${esc(restoreDrill.error)}</div>` : ""}
      </div>
    </div>
    <div class="card" style="padding:0"><div class="card-head" style="padding:16px 16px 0"><h3>${t("operations.incidents")}</h3><span class="hint">${t("operations.latest", { count: Math.min(incidents.length, 50) })}</span></div>
      ${incidents.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>${t("system.status")}</th><th>${t("operations.check")}</th><th>${t("operations.message")}</th><th>${t("operations.firstSeen")}</th></tr></thead><tbody>${incidents.map((incident) => `<tr><td><span class="badge ${incident.status === "resolved" ? "success" : opsTone(incident.severity)}">${esc(incident.status || "active")}</span></td><td class="fw-600">${esc(incident.name || incident.checkId)}</td><td class="muted">${esc(incident.message || "")}</td><td class="muted nowrap">${opsAge(incident.firstSeenAt)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty" style="min-height:180px"><div class="empty-ico">${icon("check")}</div><h4>${t("operations.noIncidents")}</h4><p>${t("operations.noIncidentsText")}</p></div>`}
    </div>`;
}

function fourCReadinessHTML(readiness) {
  if (!readiness || readiness.error) return `<div class="alert warning mb-4"><span class="a-ico">${icon("warn")}</span><div class="a-body"><div class="a-title">${t("operations.readinessUnavailable")}</div><div class="a-desc">${esc(readiness?.error || t("operations.noAudit"))}</div></div></div>`;
  const sections = readiness.sections || [];
  const recommendations = readiness.recommendations || [];
  return `
    <div class="card pad-lg mb-4">
      <div class="card-head">
        <div><h3>${t("operations.readiness")}</h3><p class="hint mt-1">${t("operations.readinessText")}</p></div>
        <span class="badge ${readiness.score >= 80 ? "success" : readiness.score >= 50 ? "warning" : "error"}">${t("operations.readyPercent", { score: esc(readiness.score) })}</span>
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
      ${recommendations.length ? `<div class="readiness-actions mt-4"><div class="fw-700 mb-3">${t("operations.nextActions")}</div><div class="grid cols-2">${recommendations.map((item) => `<a class="readiness-action" href="${esc(item.href)}"><div><span class="eyebrow">${esc(item.section)}</span><div class="fw-600 mt-1">${esc(item.title)}</div><div class="hint mt-1">${esc(item.detail)}</div></div>${icon("arrowright")}</a>`).join("")}</div></div>` : `<div class="alert success mt-4"><span class="a-ico">${icon("check")}</span><div class="a-body"><div class="a-title">${t("operations.allReady")}</div><div class="a-desc">${t("operations.noGaps")}</div></div></div>`}
    </div>`;
}

function opsFact(label, value) {
  return `<div class="row between" style="padding-bottom:10px;border-bottom:1px solid var(--border)"><span class="muted">${esc(label)}</span><span class="fw-600">${esc(value)}</span></div>`;
}
function opsTone(status) { return status === "healthy" || status === "success" ? "success" : status === "critical" || status === "error" ? "error" : status === "degraded" || status === "running" ? "warning" : "neutral"; }
function opsStatusText(status) { return t(`operations.status.${status || "unknown"}`); }
function opsAge(value) { const stamp = value ? new Date(value).getTime() : NaN; return Number.isFinite(stamp) ? timeAgo(stamp) : t("operations.never"); }
function opsBytes(value) { if (!Number.isFinite(Number(value)) || Number(value) <= 0) return t("operations.unknown"); const units = ["B", "KB", "MB", "GB", "TB"]; let amount = Number(value), index = 0; while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; } return `${amount.toFixed(index ? 1 : 0)} ${units[index]}`; }

/* ============================ GUARDRAILS ============================ */
let guardrailsState = null;
let guardrailsError = "";
let guardrailsLoading = false;

export const guardrails = {
  title: "Guardrails",
  render() {
    if (!api.on) return head(t("guardrails.title"), t("guardrails.subtitle")) + demoNote(t("guardrails.backendRequired"));
    if (guardrailsError) return head(t("guardrails.title"), t("guardrails.subtitle"), `<button class="btn btn-secondary" id="guardsRefresh">${icon("refresh")}${t("system.retry")}</button>`) + errCard(guardrailsError);
    if (!guardrailsState) return head(t("guardrails.title"), t("guardrails.subtitle")) + loadingCard(t("guardrails.loading"));
    const rules = guardrailsState.rules || [];
    const audit = guardrailsState.audit || [];
    return head(t("guardrails.title"), t("guardrails.enforcedCount", { active: guardrailsState.active, total: guardrailsState.total }), `<button class="btn btn-secondary" id="guardsRefresh">${icon("refresh")}${t("system.refresh")}</button>`) + `
      <div class="alert success mb-4"><span class="a-ico">${icon("shield")}</span><div class="a-body"><div class="a-title">${t("guardrails.livePolicy")}</div><div class="a-desc">${t("guardrails.livePolicyText")}</div></div></div>
      <div class="grid cols-2">
        ${rules.map((rule) => `<div class="card"><div class="row between gap-3"><div class="row gap-3"><div class="aico" style="background:${store.colors.green}">${icon("shield")}</div><div class="stack"><span class="fw-700">${esc(rule.name)}</span><span class="hint">${esc(rule.description)}</span></div></div><div class="stack" style="align-items:flex-end"><span class="badge success"><span class="dot"></span>${t("guardrails.enforced")}</span><span class="hint">${esc(rule.enforcement)}</span></div></div></div>`).join("")}
      </div>
      <div class="card mt-4" style="padding:0"><div class="card-head" style="padding:16px 16px 0"><div><h3>${t("guardrails.audit")}</h3><p class="hint mt-1">${t("guardrails.auditText")}</p></div><span class="badge neutral">${t("guardrails.recentCount", { count: audit.length })}</span></div><div class="table-wrap"><table class="tbl"><thead><tr><th>${t("guardrails.action")}</th><th>${t("guardrails.actor")}</th><th>${t("guardrails.target")}</th><th>${t("guardrails.detail")}</th><th>${t("system.when")}</th></tr></thead><tbody>${audit.length ? audit.map((item) => `<tr><td class="mono fw-600">${esc(item.action)}</td><td>${esc(item.actor)}</td><td class="mono muted">${esc(item.target)}</td><td class="muted">${esc(item.detail || "—")}</td><td class="muted nowrap">${timeAgo(new Date(item.at).getTime())}</td></tr>`).join("") : `<tr><td colspan="5" class="muted">${t("guardrails.noAudit")}</td></tr>`}</tbody></table></div></div>`;
  },
  mount(root) {
    if (!api.on) return;
    root.querySelector("#guardsRefresh")?.addEventListener("click", () => loadGuardrails(true));
    if (!guardrailsState && !guardrailsLoading) loadGuardrails();
  },
};

async function loadGuardrails(force = false) {
  if (guardrailsLoading && !force) return;
  guardrailsLoading = true;
  try {
    const [state, audit] = await Promise.all([api.governance.guardrails(), api.governance.audit(40)]);
    guardrailsState = { ...state, audit };
    guardrailsError = "";
  }
  catch (error) { guardrailsError = error.message || "Guardrails unavailable"; }
  guardrailsLoading = false;
  rerender();
}

/* ============================ SECRETS ============================ */
let secretsState = null;
let secretsError = "";
let secretsLoading = false;

export const secrets = {
  title: "Secrets",
  render() {
    const actions = `<div class="row gap-2"><button class="btn btn-secondary" id="secretsRefresh">${icon("refresh")}${t("system.refresh")}</button><button class="btn btn-primary" id="addSecret">${icon("plus")}${t("secrets.add")}</button></div>`;
    if (!api.on) return head(t("secrets.title"), t("secrets.subtitle")) + demoNote(t("secrets.backendRequired"));
    if (secretsError) return head(t("secrets.title"), t("secrets.subtitle"), actions) + errCard(secretsError);
    if (!secretsState) return head(t("secrets.title"), t("secrets.subtitle"), actions) + loadingCard(t("secrets.loading"));
    return head(t("secrets.title"), t("secrets.count", { count: secretsState.length }), actions) + `
      <div class="alert info mb-4"><span class="a-ico">${icon("lock")}</span><div class="a-body"><div class="a-title">${t("secrets.writeOnly")}</div><div class="a-desc">${t("secrets.writeOnlyText")}</div></div></div>
      <div class="card" style="padding:0"><div class="table-wrap"><table class="tbl">
        <thead><tr><th>${t("secrets.name")}</th><th>${t("secrets.description")}</th><th>${t("secrets.value")}</th><th>${t("system.updated")}</th><th></th></tr></thead>
        <tbody>${secretsState.length ? secretsState.map((secret) => `<tr><td class="mono fw-600">${esc(secret.name)}</td><td class="muted">${esc(secret.description || t("secrets.noDescription"))}</td><td><span class="badge success">${icon("lock")}${t("secrets.encrypted")}</span></td><td class="muted nowrap">${timeAgo(new Date(secret.updatedAt).getTime())}</td><td><button class="btn sm btn-ghost" data-del-secret="${secret.id}" style="color:var(--error)" title="${t("system.delete")}">${icon("trash")}</button></td></tr>`).join("") : `<tr><td colspan="5"><div class="empty" style="min-height:180px"><div class="empty-ico">${icon("lock")}</div><h4>${t("secrets.empty")}</h4><p>${t("secrets.emptyText")}</p></div></td></tr>`}</tbody>
      </table></div></div>`;
  },
  mount(root) {
    if (!api.on) return;
    root.querySelector("#secretsRefresh")?.addEventListener("click", () => loadSecrets(true));
    root.querySelectorAll("[data-del-secret]").forEach((button) => (button.onclick = () => confirmDialog({
      title: t("secrets.deleteTitle"),
      message: t("secrets.deleteText"),
      confirmText: t("system.delete"),
      onConfirm: async () => {
        try {
          await api.governance.deleteSecret(button.dataset.delSecret);
          toast("success", t("secrets.deleted"));
          await loadSecrets(true);
        } catch (error) { toast("error", t("secrets.deleteFailed"), error.message); }
      },
    })));
    const add = root.querySelector("#addSecret");
    if (add) add.onclick = () => openModal({
      title: t("secrets.add"), width: 460,
      body: `<div class="field"><label class="label">${t("secrets.name")}</label><input class="input mono" id="sn" placeholder="MY_API_KEY" autocomplete="off"/></div><div class="field"><label class="label">${t("secrets.description")}</label><input class="input" id="sd" placeholder="${t("secrets.descriptionPlaceholder")}"/></div><div class="field"><label class="label">${t("secrets.value")}</label><input class="input mono" id="sv" type="password" placeholder="••••••••" autocomplete="new-password"/><span class="hint">${t("secrets.valueHint")}</span></div><div id="secretError"></div>`,
      footer: `<button class="btn btn-secondary" data-close>${t("system.cancel")}</button><button class="btn btn-primary" id="sok">${icon("lock")}${t("secrets.save")}</button>`,
      onMount: (modal) => (modal.querySelector("#sok").onclick = async (event) => {
        const button = event.currentTarget;
        const name = modal.querySelector("#sn").value.trim();
        const value = modal.querySelector("#sv").value;
        button.classList.add("loading");
        try {
          await api.governance.setSecret({ name, value, description: modal.querySelector("#sd").value.trim() });
          closeOverlay();
          toast("success", t("secrets.saved"), name.toUpperCase());
          await loadSecrets(true);
        } catch (error) {
          modal.querySelector("#secretError").innerHTML = `<div class="field-error">${esc(error.message)}</div>`;
          button.classList.remove("loading");
        }
      }),
    });
    if (!secretsState && !secretsLoading) loadSecrets();
  },
};

async function loadSecrets(force = false) {
  if (secretsLoading && !force) return;
  secretsLoading = true;
  try { secretsState = await api.governance.secrets(); secretsError = ""; }
  catch (error) { secretsError = error.message || "Secret vault unavailable"; }
  secretsLoading = false;
  rerender();
}

/* ============================ EVALUATIONS ============================ */
let evaluationsState = null;
let evaluationsError = "";
let evaluationsLoading = false;

export const evaluations = {
  title: "Evaluations",
  render() {
    const actions = `<div class="row gap-2"><button class="btn btn-secondary" id="evalRefresh">${icon("refresh")}${t("system.refresh")}</button><button class="btn btn-primary" id="runEval">${icon("play")}${t("evaluations.run")}</button></div>`;
    if (!api.on) return head(t("evaluations.title"), t("evaluations.readiness")) + demoNote(t("evaluations.backendRequired"));
    if (evaluationsError) return head(t("evaluations.title"), t("evaluations.readiness"), actions) + errCard(evaluationsError);
    if (!evaluationsState) return head(t("evaluations.title"), t("evaluations.readiness"), actions) + loadingCard(t("evaluations.loading"));
    const runs = evaluationsState.runs || [];
    const summary = evaluationsState.summary || {};
    return head(t("evaluations.title"), t("evaluations.subtitle"), actions) + `
      <div class="grid cols-4" style="margin-bottom:16px">
        ${statMini(t("evaluations.average"), summary.average == null ? "—" : summary.average, "evaluations")}
        ${statMini(t("evaluations.passRate"), summary.passRate == null ? "—" : `${summary.passRate}%`, "check")}
        ${statMini(t("evaluations.checks"), summary.totalCases || 0, "layers")}
        ${statMini(t("evaluations.attention"), summary.regressions || 0, "down")}
      </div>
      ${runs.length ? `<div class="grid" style="grid-template-columns:1fr 2fr">
        <div class="card pad-lg"><div class="card-head"><h3>${t("evaluations.latest")}</h3><span class="badge ${runs[0].pass ? "success" : "warning"}">${esc(runs[0].framework)}</span></div><div style="display:grid;place-items:center;padding:8px">${ring(runs[0].score, 120, 12)}</div><div class="row between text-sm muted mt-4"><span>${t("evaluations.passed", { passed: runs[0].passedCases, total: runs[0].cases })}</span><span>${timeAgo(new Date(runs[0].at).getTime())}</span></div></div>
        <div class="card" style="padding:0"><div class="card-head" style="padding:16px 16px 0"><h3>${t("evaluations.recent")}</h3></div><div class="table-wrap"><table class="tbl">
          <thead><tr><th>${t("evaluations.eval")}</th><th>${t("evaluations.agent")}</th><th>${t("evaluations.cases")}</th><th>${t("evaluations.score")}</th><th>${t("evaluations.result")}</th><th>${t("system.when")}</th></tr></thead>
          <tbody>${runs.map((run) => `<tr><td class="fw-600">${esc(run.name)}</td><td class="muted">${esc(run.agent)}</td><td class="mono">${run.passedCases}/${run.cases}</td><td><div class="row gap-2">${run.score}<span class="meter"><span style="width:${run.score}%;background:${run.pass ? "var(--success)" : "var(--warning)"}"></span></span></div></td><td>${run.pass ? `<span class="badge success"><span class="dot"></span>${t("evaluations.passedStatus")}</span>` : `<span class="badge warning"><span class="dot"></span>${t("evaluations.attention")}</span>`}</td><td class="muted nowrap">${timeAgo(new Date(run.at).getTime())}</td></tr>`).join("")}</tbody>
        </table></div></div>
      </div>` : `<div class="empty card" style="min-height:280px"><div class="empty-ico">${icon("evaluations")}</div><h4>${t("evaluations.empty")}</h4><p>${t("evaluations.emptyText")}</p></div>`}`;
  },
  mount(root) {
    if (!api.on) return;
    root.querySelector("#evalRefresh")?.addEventListener("click", () => loadEvaluations(true));
    root.querySelector("#runEval")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.classList.add("loading");
      try {
        const run = await api.governance.runEvaluation();
        toast(run.pass ? "success" : "info", t("evaluations.completed", { score: run.score }), t("evaluations.passed", { passed: run.passedCases, total: run.cases }));
        await loadEvaluations(true);
      } catch (error) {
        toast("error", t("evaluations.failed"), error.message);
        button.classList.remove("loading");
      }
    });
    if (!evaluationsState && !evaluationsLoading) loadEvaluations();
  },
};

async function loadEvaluations(force = false) {
  if (evaluationsLoading && !force) return;
  evaluationsLoading = true;
  try { evaluationsState = await api.governance.evaluations(); evaluationsError = ""; }
  catch (error) { evaluationsError = error.message || "Evaluations unavailable"; }
  evaluationsLoading = false;
  rerender();
}

/* ---------- shared mini stat ---------- */
function statMini(label, value, ic) {
  return `<div class="stat"><div class="stat-top"><span class="stat-label">${label}</span><span class="stat-ico">${icon(ic)}</span></div><div class="stat-value" style="font-size:26px">${value}</div></div>`;
}

/* ============================================================
   Backend-aware helpers (MCP + Integrations)
   ============================================================ */
function demoNote(txt) {
  return `<div class="alert info mb-4"><span class="a-ico">${icon("info")}</span><div class="a-body"><div class="a-title">${esc(t("alert.noBackend"))}</div><div class="a-desc">${esc(txt)}</div></div></div>`;
}
function loadingCard(txt) {
  return `<div class="card"><div class="row gap-2"><div class="spinner"></div><span class="muted">${esc(txt)}</span></div></div>`;
}
function errCard(msg) {
  return `<div class="alert error"><span class="a-ico">${icon("x")}</span><div class="a-body"><div class="a-title">${esc(t("alert.requestFailed"))}</div><div class="a-desc">${esc(msg)}</div></div></div>`;
}

/* ---- MCP ---- */
function mcpRowHTML(m) {
  const count = Array.isArray(m.tools) ? m.tools.length : (m.tools || 0);
  const active = m.status === "active";
  const badge = active ? `<span class="badge success"><span class="dot"></span>${t("mcp.active")}</span>`
    : m.status === "error" ? `<span class="badge error"><span class="dot"></span>${t("mcp.error")}</span>`
    : `<span class="badge neutral">${t("mcp.stopped")}</span>`;
  return `<tr>
    <td><div class="cell-main"><div class="aico" style="background:${store.colors.blue};width:30px;height:30px">${icon("mcp")}</div><div class="stack"><span class="fw-600">${esc(m.name)}</span><span class="cell-sub">${esc(m.desc || m.kind || "")}</span></div></div></td>
    <td>${badge}</td>
    <td class="mono">${count}</td>
    <td><div class="row gap-2">
      ${active ? `<button class="btn sm btn-secondary" data-mcpstop="${m.id}">${t("mcp.stop")}</button>` : `<button class="btn sm btn-primary" data-mcpstart="${m.id}">${t("mcp.start")}</button>`}
      ${active && count ? `<button class="btn sm btn-ghost" data-mcptools="${m.id}">${icon("tools")}${t("mcp.tools")}</button>` : ""}
      ${m.kind === "custom" ? `<button class="icon-btn" data-mcpdel="${m.id}" title="${t("system.delete")}">${icon("trash")}</button>` : ""}
    </div></td>
  </tr>`;
}
function mcpTableHTML(rows) {
  return `<div class="card" style="padding:0"><div class="table-wrap"><table class="tbl"><thead><tr><th>${t("mcp.server")}</th><th>${t("system.status")}</th><th>${t("mcp.tools")}</th><th>${t("mcp.actions")}</th></tr></thead><tbody id="mcpRows">${rows.map(mcpRowHTML).join("")}</tbody></table></div></div>`;
}
async function mcpMountReal(root) {
  const body = root.querySelector("#mcpBody");
  let servers = [];
  try { servers = await api.mcp.list(); } catch (e) { body.innerHTML = errCard(e.message); return; }
  body.innerHTML = mcpTableHTML(servers);
  root.querySelectorAll("[data-mcpstart]").forEach((b) => (b.onclick = async () => {
    b.classList.add("loading");
    try { const r = await api.mcp.connect(b.dataset.mcpstart); toast("success", t("mcp.started"), t("mcp.discovered", { count: r.tools?.length || 0 })); }
    catch (e) { toast("error", t("mcp.startFailed"), e.message); }
    rerender();
  }));
  root.querySelectorAll("[data-mcpstop]").forEach((b) => (b.onclick = async () => {
    try { await api.mcp.disconnect(b.dataset.mcpstop); toast("info", t("mcp.serverStopped")); } catch (e) { toast("error", t("mcp.stopFailed"), e.message); }
    rerender();
  }));
  root.querySelectorAll("[data-mcpdel]").forEach((b) => (b.onclick = () => confirmDialog({
    title: t("mcp.deleteTitle"), message: t("mcp.deleteText"), confirmText: t("system.delete"),
    onConfirm: async () => { try { await api.mcp.remove(b.dataset.mcpdel); toast("success", t("mcp.removed")); rerender(); } catch (e) { toast("error", t("system.failed"), e.message); } },
  })));
  root.querySelectorAll("[data-mcptools]").forEach((b) => (b.onclick = () => openToolRunner(servers.find((s) => s.id === b.dataset.mcptools))));
  wireAddMcp(root, true);
}
function openToolRunner(server) {
  const tools = server.tools || [];
  openModal({
    title: t("mcp.runTool", { name: server.name }), width: 540,
    body: `<div class="field"><label class="label">${t("mcp.tool")}</label><select class="select" id="trTool">${tools.map((tool) => `<option value="${esc(tool.name)}">${esc(tool.name)}${tool.description ? " — " + esc(tool.description) : ""}</option>`).join("")}</select></div>
      <div class="field"><label class="label">${t("mcp.arguments")}</label><textarea class="textarea mono" id="trArgs" rows="3">{}</textarea></div>
      <div id="trResult"></div>`,
    footer: `<button class="btn btn-secondary" data-close>${t("system.close")}</button><button class="btn btn-primary" id="trRun">${icon("play")}${t("mcp.run")}</button>`,
    onMount: (m) => (m.querySelector("#trRun").onclick = async () => {
      let args = {};
      try { args = JSON.parse(m.querySelector("#trArgs").value || "{}"); } catch { return toast("error", t("mcp.invalidJson")); }
      const btn = m.querySelector("#trRun"); btn.classList.add("loading");
      try {
        const r = await api.mcp.call(server.id, m.querySelector("#trTool").value, args);
        const text = (r.result?.content || []).map((c) => c.text).filter(Boolean).join("\n");
        m.querySelector("#trResult").innerHTML = `<div class="section-title">${t("mcp.result")}</div><div class="codeblock"><pre>${esc(text || JSON.stringify(r.result, null, 2))}</pre></div>`;
      } catch (e) { toast("error", t("mcp.callFailed"), e.message); }
      btn.classList.remove("loading");
    }),
  });
}
function wireAddMcp(root, real) {
  const add = root.querySelector("#addMcp");
  if (!add) return;
  add.onclick = () => openModal({
    title: t("mcp.add"), width: 540,
    body: `<div class="field"><label class="label">${t("mcp.name")}</label><input class="input" id="mn" placeholder="my-server"/></div>
      <div class="field"><label class="label">${t("mcp.command")}</label><input class="input mono" id="mcmd" placeholder="npx"/></div>
      <div class="field"><label class="label">${t("mcp.argumentsSpace")}</label><input class="input mono" id="marg" placeholder="-y @modelcontextprotocol/server-filesystem ."/></div>`,
    footer: `<button class="btn btn-secondary" data-close>${t("system.cancel")}</button><button class="btn btn-primary" id="mok">${icon("plus")}${t("mcp.add")}</button>`,
    onMount: (m) => (m.querySelector("#mok").onclick = async () => {
      const name = m.querySelector("#mn").value.trim(), command = m.querySelector("#mcmd").value.trim();
      if (!name || !command) return toast("error", t("mcp.required"));
      const args = m.querySelector("#marg").value.trim();
      try {
        if (real) await api.mcp.add({ name, command, args });
        else store.set((s) => s.mcpServers.push({ id: store.uid(), name, cmd: command + " " + args, status: "idle", tools: 0 }));
        closeOverlay(); toast("success", t("mcp.added"), name); rerender();
      } catch (e) { toast("error", t("mcp.addFailed"), e.message); }
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
    <div class="row between mt-4">${i.connected ? `<span class="badge success"><span class="dot"></span>${t("integrations.connected")}</span>` : `<span class="badge neutral">${t("integrations.notConnected")}</span>`}<button class="btn sm ${i.connected ? "btn-secondary" : "btn-primary"}" data-int="${i.id}">${t(i.connected ? "integrations.disconnect" : "integrations.connect")}</button></div></div>`;
}
function intMountLocal(root) {
  root.querySelectorAll("[data-int]").forEach((b) => (b.onclick = () => {
    const i = store.state.integrations.find((x) => x.id === b.dataset.int);
    store.set((s) => (s.integrations.find((x) => x.id === b.dataset.int).connected = !i.connected));
    toast(i.connected ? "info" : "success", t(i.connected ? "integrations.disconnectedName" : "integrations.connectedName", { name: i.name })); rerender();
  }));
}
function intCardReal(i) {
  return `<div class="card tile" data-intcard="${i.provider}"><div class="row between"><div class="row gap-3"><div class="aico" style="background:${store.colors[i.color] || store.colors.violet}">${icon(i.icon)}</div><div class="stack"><span class="fw-700">${esc(i.name)}</span><span class="hint">${esc(i.desc)}</span></div></div></div>
    ${i.lastResult ? `<div class="hint mt-2">${i.lastResult.ok ? "✓" : "✕"} ${esc(i.lastResult.detail || "")}</div>` : ""}
    <div class="row between mt-4">${i.connected ? `<span class="badge success"><span class="dot"></span>${t("integrations.connected")}</span>` : `<span class="badge neutral">${t("integrations.notConnected")}</span>`}
      <div class="row gap-2">${i.connected && i.provider === "slack" ? `<button class="btn sm btn-ghost" data-intsend="${i.provider}">${t("integrations.sendTest")}</button>` : ""}${i.connected && i.provider === "mila" ? `<button class="btn sm btn-ghost" data-intstatus="mila">${t("system.status")}</button><button class="btn sm btn-ghost" data-intdevices="mila">${t("integrations.devices")}</button><button class="btn sm btn-primary" data-intcode="mila">${t("integrations.newCode")}</button>` : ""}<button class="btn sm ${i.connected ? "btn-secondary" : "btn-primary"}" data-intbtn="${i.provider}">${t(i.connected ? "integrations.disconnect" : "integrations.connect")}</button></div>
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
    if (send) send.onclick = async () => { try { await api.integrations.slackSend("Test message from Agentic OS"); toast("success", t("integrations.sentSlack")); } catch (e) { toast("error", t("integrations.sendFailed"), e.message); } };
    const status = card.querySelector("[data-intstatus]");
    if (status) status.onclick = async () => {
      try {
        const s = await api.integrations.milaStatus();
        toast(s.voiceConfigured ? "success" : "info", "MILA Voice", s.voiceConfigured ? `Ready · ${s.liveModel}` : "Backend online · Gemini key missing");
      } catch (e) { toast("error", t("integrations.milaStatusFailed"), e.message); }
    };
    const code = card.querySelector("[data-intcode]");
    if (code) code.onclick = () => openMilaCode();
    const devices = card.querySelector("[data-intdevices]");
    if (devices) devices.onclick = () => openMilaDevices();
  });
}
function openMilaCode() {
  openModal({
    title: t("integrations.connectMila"), width: 460,
    body: `<div class="field"><label class="label">${t("integrations.accountLabel")}</label><input class="input" id="milaLabel" placeholder="${t("integrations.nameEmail")}"/></div><div id="milaCodeResult" class="mt-3"></div>`,
    footer: `<button class="btn btn-secondary" data-close>${t("system.close")}</button><button class="btn btn-primary" id="milaCreateCode">${t("integrations.createCode")}</button>`,
    onMount: (m) => (m.querySelector("#milaCreateCode").onclick = async () => {
      const btn = m.querySelector("#milaCreateCode"); btn.classList.add("loading");
      try {
        const result = await api.integrations.milaConnectionCode(m.querySelector("#milaLabel").value.trim() || "MILA user");
        m.querySelector("#milaCodeResult").innerHTML = `<div class="alert success"><span class="a-ico">${icon("key")}</span><div class="a-body"><div class="a-title mono" style="font-size:22px;letter-spacing:3px">${esc(result.code)}</div><div class="a-desc">Enter in MILA → Settings → AI Providers. Expires in 10 minutes.</div></div></div>`;
      } catch (e) { m.querySelector("#milaCodeResult").innerHTML = `<div class="alert error"><span class="a-ico">${icon("x")}</span><div class="a-body"><div class="a-title">${t("integrations.codeFailed")}</div><div class="a-desc">${esc(e.message)}</div></div></div>`; }
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
    title: t("integrations.milaDevices"), width: 620,
    body: `<div id="milaDevicesList" class="stack gap-2"><div class="hint">${t("integrations.loadingDevices")}</div></div>`,
    footer: `<button class="btn btn-secondary" data-close>${t("system.close")}</button>`,
    onMount: async (m) => {
      const slot = m.querySelector("#milaDevicesList");
      const render = (devices) => {
        if (!devices.length) { slot.innerHTML = `<div class="empty">${t("integrations.noDevices")}</div>`; return; }
        slot.innerHTML = devices.map((device) => `<div class="card tile"><div class="row between gap-3"><div class="stack"><strong>${esc(device.label || "MILA device")}</strong><span class="hint">Paired ${esc(milaDeviceTime(device.createdAt))}</span>${device.revokedAt ? `<span class="hint">Revoked ${esc(milaDeviceTime(device.revokedAt))}</span>` : ""}</div><div class="row gap-2"><span class="badge ${device.active ? "success" : "neutral"}">${device.active ? "Active" : "Revoked"}</span>${device.active ? `<button class="btn sm btn-secondary" data-mila-revoke="${esc(device.id)}">Revoke</button>` : ""}</div></div></div>`).join("");
        slot.querySelectorAll("[data-mila-revoke]").forEach((button) => {
          button.onclick = async () => {
            if (!window.confirm("Revoke this MILA device? It will need a new one-time code to reconnect.")) return;
            button.classList.add("loading");
            try { await api.integrations.milaRevokeDevice(button.dataset.milaRevoke); const result = await api.integrations.milaDevices(); render(result.devices || []); toast("success", t("integrations.deviceRevoked")); }
            catch (error) { toast("error", t("integrations.revokeFailed"), error.message); }
            finally { button.classList.remove("loading"); }
          };
        });
      };
      try { const result = await api.integrations.milaDevices(); render(result.devices || []); }
      catch (error) { slot.innerHTML = `<div class="alert error"><span class="a-ico">${icon("x")}</span><div class="a-body"><div class="a-title">${t("integrations.loadDevicesFailed")}</div><div class="a-desc">${esc(error.message)}</div></div></div>`; }
    },
  });
}
function intConnect(i) {
  openModal({
    title: "Connect " + i.name, width: 480,
    body: (i.fields || []).map((f) => `<div class="field"><label class="label">${esc(f.label)}</label><input class="input mono" id="if_${f.key}" ${f.secret ? 'type="password"' : ""} placeholder="${esc(f.label)}"/></div>`).join("") + `<div id="icErr"></div>`,
    footer: `<button class="btn btn-secondary" data-close>${t("system.cancel")}</button><button class="btn btn-primary" id="icOk">${icon("lock")}${t("integrations.connectTest")}</button>`,
    onMount: (m) => (m.querySelector("#icOk").onclick = async () => {
      const cfg = {}; (i.fields || []).forEach((f) => (cfg[f.key] = m.querySelector("#if_" + f.key).value.trim()));
      const btn = m.querySelector("#icOk"); btn.classList.add("loading");
      try {
        const r = await api.integrations.connect(i.provider, cfg);
        if (r.ok) { closeOverlay(); toast("success", t("integrations.connectedName", { name: i.name }), r.detail); rerender(); }
        else m.querySelector("#icErr").innerHTML = `<div class="alert error"><span class="a-ico">${icon("x")}</span><div class="a-body"><div class="a-title">${t("integrations.connectionFailed")}</div><div class="a-desc">${esc(r.detail)}</div></div></div>`;
      } catch (e) { toast("error", "Error", e.message); }
      btn.classList.remove("loading");
    }),
  });
}
async function intDisconnect(i) {
  try { await api.integrations.disconnect(i.provider); toast("info", t("integrations.disconnectedName", { name: i.name })); rerender(); }
  catch (e) { toast("error", "Failed", e.message); }
}
