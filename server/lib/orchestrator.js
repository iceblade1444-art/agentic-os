// Public mission bridge. Hermes is the primary orchestrator in the Python
// AgentOS runtime; this module streams its validated plan and queue result into
// the GitHub dashboard's existing mission feed.
import { config } from "../config.js";
import { db } from "../store.js";
import * as mgr from "../mcp/manager.js";
import { slackSend } from "./connectors.js";
import { milaConnectionCode, milaStatus } from "./mila.js";
import { knowledge } from "./knowledge.js";
import { sharedAgentContext } from "./onboarding.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeParse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

function aggregateTools() {
  const out = [];
  for (const s of db.mcp.list()) {
    if (mgr.isLive(s.id)) for (const t of mgr.getTools(s.id)) out.push({ server: s.name, serverId: s.id, tool: t.name, description: t.description });
  }
  return out;
}
function openaiKey() { return config.openai.key || db.integrations.byProvider("openai")?.config?.apiKey || ""; }
function milaConfig() { return db.integrations.byProvider("mila")?.config || {}; }

async function llmComplete(system, input, model) {
  const key = openaiKey();
  if (!key) return "[no LLM key configured]";
  const up = await fetch(config.openai.baseUrl + "/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model: model || config.defaultModel, messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: input }], temperature: 0.5 }),
  });
  const j = await up.json();
  return j.choices?.[0]?.message?.content || "[no response]";
}

// Execute one capability (real).
async function cap(name, args) {
  switch (name) {
    case "agentic_list_tools":
      return { tools: aggregateTools() };
    case "agentic_call_tool": {
      const srv = db.mcp.list().find((s) => s.id === args.server || s.name === args.server);
      if (!srv) throw new Error("server not found: " + args.server);
      if (!mgr.isLive(srv.id)) await mgr.connect(srv);
      const r = await mgr.callTool(srv.id, args.tool, args.args || {});
      if (srv.kind === "obsidian") await knowledge.recordMcp(args.tool, args.args || {}, { actor: "Built-in Orchestrator", source: "mission" });
      return { result: (r.result?.content || r.content || []).map((c) => c.text).filter(Boolean).join("\n") || JSON.stringify(r) };
    }
    case "agentic_list_integrations":
      return { integrations: db.integrations.list().map((i) => ({ provider: i.provider, connected: i.connected })) };
    case "agentic_send_slack":
      await slackSend(db.integrations.byProvider("slack")?.config || {}, args.text);
      return { sent: true };
    case "agentic_mila_status":
      return milaStatus(milaConfig());
    case "agentic_mila_connection_code":
      return milaConnectionCode(milaConfig(), args.label || "MILA user");
    case "agentic_run_llm":
      return { text: await llmComplete(args.instructions, args.input, args.model) };
    default:
      throw new Error("unknown tool: " + name);
  }
}

const TOOL_SPECS = [
  { type: "function", function: { name: "agentic_list_tools", description: "List tools available across MCP servers connected in Agentic OS.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "agentic_call_tool", description: "Call a tool on a connected Agentic OS MCP server.", parameters: { type: "object", properties: { server: { type: "string", description: "server id or name" }, tool: { type: "string" }, args: { type: "object" } }, required: ["server", "tool"] } } },
  { type: "function", function: { name: "agentic_list_integrations", description: "List integration connections and status.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "agentic_send_slack", description: "Send a message to Slack (if the integration is connected).", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
  { type: "function", function: { name: "agentic_mila_status", description: "Check whether the connected MILA voice backend and Gemini Live are ready.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "agentic_mila_connection_code", description: "Create a 10-minute one-time code for connecting the MILA mobile app.", parameters: { type: "object", properties: { label: { type: "string", description: "User name or email" } } } } },
  { type: "function", function: { name: "agentic_run_llm", description: "Run a one-shot sub-LLM completion for a subtask.", parameters: { type: "object", properties: { instructions: { type: "string" }, input: { type: "string" } }, required: ["input"] } } },
  { type: "function", function: { name: "finish", description: "Finish the mission with a summary of what was accomplished.", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
];

async function openaiChat(key, messages) {
  const up = await fetch(config.openai.baseUrl + "/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model: config.defaultModel, messages, tools: TOOL_SPECS, tool_choice: "auto", temperature: 0.3 }),
  });
  if (!up.ok) throw new Error("OpenAI " + up.status + ": " + (await up.text()).slice(0, 300));
  return up.json();
}

async function runtimeJson(path, options = {}) {
  const response = await fetch(config.agentosRuntimeUrl + path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `AgentOS runtime HTTP ${response.status}`);
  return data;
}

export async function runMission(mission, emit, user = null) {
  emit({ type: "status", message: "Mission accepted by Hermes", status: "running" });
  emit({ type: "think", message: "Hermes is preparing an approval-gated AgentOS plan." });
  const hermes = await runtimeJson("/api/orchestrator/status");
  if (!hermes.ready) throw new Error(`Hermes is not ready: ${hermes.error || "unknown status"}`);
  emit({
    type: "tool_result",
    message: `Hermes ${hermes.version || "ready"} · ${hermes.model || "configured model"}`,
    data: { orchestrator: "hermes", profile: hermes.profile, provider: hermes.provider, model: hermes.model },
  });
  const result = await runtimeJson("/api/orchestrator/create-and-run", {
    method: "POST",
    body: { goal: mission.goal || mission.title, context: sharedAgentContext(user), max_steps: 20 },
  });
  const created = result.created || {};
  const run = result.run || {};
  emit({
    type: "tool_result",
    message: `Hermes created ${created.tasks || 0} validated task cards for ${created.slug || mission.title}`,
    data: {
      project: created.slug,
      tasks: created.tasks,
      planSource: created.orchestrator?.plan_source,
      planSummary: created.orchestrator?.plan_summary,
      approvals: (created.approvals || []).length,
      executed: run.executed_count || 0,
    },
  });
  if (run.status === "error") throw new Error(run.errors?.[0]?.error || "AgentOS queue execution failed");
  if (run.status === "waiting_for_human_gate" || (created.approvals || []).length) {
    emit({
      type: "approval_required",
      message: "Hermes reached an approval gate. Review the requested action in AgentOS Approvals.",
      data: { project: created.slug, approvals: created.approvals || [] },
      status: "waiting_for_approval",
    });
    return;
  }
  emit({
    type: "complete",
    message: created.orchestrator?.plan_summary || `Hermes completed the safe AgentOS queue for ${created.slug || mission.title}.`,
    status: "completed",
  });
}

async function runBuiltInMission(mission, emit) {
  emit({ type: "status", message: "Legacy built-in mission started", status: "running" });
  const key = openaiKey();
  if (!key) return demoRun(mission, emit);

  const messages = [
    { role: "system", content: "You are Hermes, an orchestrator for Agentic OS. Accomplish the user's mission by calling the available tools. Think briefly, act, and narrate each step. When finished, call finish with a concise summary. Use at most 8 tool steps." },
    { role: "user", content: `Mission: ${mission.title}\nGoal: ${mission.goal || mission.title}` },
  ];
  emit({ type: "think", message: `Planning with OpenAI (${config.defaultModel})…` });
  for (let step = 0; step < 8; step++) {
    let resp;
    try { resp = await openaiChat(key, messages); } catch (e) { emit({ type: "error", message: e.message, status: "failed" }); return; }
    const msg = resp.choices?.[0]?.message;
    if (!msg) { emit({ type: "error", message: "No model response", status: "failed" }); return; }
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      emit({ type: "assistant", message: msg.content || "(done)" });
      emit({ type: "complete", message: msg.content || "Mission finished", status: "completed" });
      return;
    }
    for (const c of calls) {
      const args = safeParse(c.function.arguments);
      if (c.function.name === "finish") { emit({ type: "complete", message: args.summary || "Done", status: "completed" }); return; }
      emit({ type: "tool_call", message: c.function.name, data: args });
      let result;
      try { result = await cap(c.function.name, args); emit({ type: "tool_result", message: c.function.name, data: result }); }
      catch (e) { result = { error: e.message }; emit({ type: "tool_error", message: `${c.function.name}: ${e.message}` }); }
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result).slice(0, 4000) });
    }
  }
  emit({ type: "complete", message: "Reached step limit", status: "completed" });
}

async function demoRun(mission, emit) {
  emit({ type: "think", message: "No OpenAI key set — running a scripted demo that still executes real tools." });
  await sleep(250);
  emit({ type: "tool_call", message: "agentic_list_tools", data: {} });
  const tools = await cap("agentic_list_tools", {});
  emit({ type: "tool_result", message: "agentic_list_tools", data: tools });
  await sleep(250);
  const add = tools.tools.find((t) => t.tool === "add");
  if (add) {
    emit({ type: "tool_call", message: "agentic_call_tool", data: { server: add.server, tool: "add", args: { a: 21, b: 21 } } });
    const r = await cap("agentic_call_tool", { server: add.serverId, tool: "add", args: { a: 21, b: 21 } });
    emit({ type: "tool_result", message: "agentic_call_tool → " + r.result });
  } else {
    emit({ type: "log", message: "Tip: Start the 'sample-tools' MCP server so the orchestrator has tools to call." });
  }
  await sleep(250);
  emit({ type: "complete", message: "Demo mission complete. Set OPENAI_API_KEY (or connect OpenAI) for full autonomous orchestration.", status: "completed" });
}
