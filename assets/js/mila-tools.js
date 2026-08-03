const confirmationToken = {
  type: "string",
  description: "One-time token returned when this exact action was staged. Omit it on the first call; reuse it only after the user explicitly confirms.",
};

export const MILA_TOOLS = [
  {
    name: "get_system_status",
    description: "Read the current Hermes, Kanban, Obsidian and Claude Workspace status.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_kanban_tasks",
    description: "List real tasks on the Agentic OS Hermes Kanban board, optionally filtered.",
    parameters: { type: "object", properties: {
      status: { type: "string", description: "Optional task status such as triage, ready, running, blocked, review or done" },
      assignee: { type: "string", description: "Optional profile: default, scout, scribe, reach or dev" },
      query: { type: "string", description: "Optional title or summary search" },
    } },
  },
  {
    name: "get_kanban_task",
    description: "Read one real Kanban task by id.",
    parameters: { type: "object", properties: { id: { type: "string", description: "Kanban task id" } }, required: ["id"] },
  },
  {
    name: "create_kanban_task",
    description: "Stage or confirm creation of a visible Kanban task. This changes state and always uses two-step confirmation.",
    parameters: { type: "object", properties: {
      title: { type: "string" }, body: { type: "string" },
      initialStatus: { type: "string", enum: ["triage", "todo", "ready"] },
      assignee: { type: "string", enum: ["default", "scout", "scribe", "reach", "dev"] },
      priority: { type: "integer", minimum: 0, maximum: 3 }, confirmationToken,
    }, required: ["title"] },
  },
  {
    name: "delegate_to_hermes",
    description: "Stage or confirm a real orchestration task for Hermes. The confirmed task appears in Kanban and Hermes starts planning it.",
    parameters: { type: "object", properties: {
      title: { type: "string", description: "Short task title" },
      goal: { type: "string", description: "Complete goal, context, constraints and definition of done" },
      priority: { type: "integer", minimum: 0, maximum: 3 }, confirmationToken,
    }, required: ["goal"] },
  },
  {
    name: "search_obsidian_notes",
    description: "Search the real Agentic OS Obsidian library and return matching note snippets.",
    parameters: { type: "object", properties: {
      query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 },
    }, required: ["query"] },
  },
  {
    name: "read_obsidian_note",
    description: "Read a note from the real Agentic OS Obsidian vault.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_obsidian_note",
    description: "Stage or confirm creation of, or an append to, an Obsidian note. This always uses two-step confirmation.",
    parameters: { type: "object", properties: {
      mode: { type: "string", enum: ["create", "append"] }, path: { type: "string" },
      content: { type: "string" }, confirmationToken,
    }, required: ["path", "content"] },
  },
  {
    name: "list_claude_sessions",
    description: "List Claude Workspace sessions and their current status.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_mcp_tools",
    description: "List all active MCP servers and tools connected to Agentic OS, including Obsidian, GitHub, Higgsfield, filesystem and desktop bridges when configured.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "call_mcp_tool",
    description: "Stage or confirm a call to any connected Agentic OS MCP tool. This always uses two-step confirmation because MCP tools can read, write or control external systems.",
    parameters: { type: "object", properties: {
      server: { type: "string", description: "MCP server id or name, for example mcp_obsidian or obsidian" },
      tool: { type: "string", description: "Tool name exposed by that MCP server" },
      args: { type: "object", description: "JSON arguments for the selected tool" },
      confirmationToken,
    }, required: ["server", "tool"] },
  },
  {
    name: "ask_claude_code",
    description: "Stage or confirm a real Claude Workspace task. Plan mode is read-only; edit mode may change project files. Both require confirmation.",
    parameters: { type: "object", properties: {
      title: { type: "string" }, request: { type: "string" },
      sessionId: { type: "string", description: "Optional existing Claude session id" },
      mode: { type: "string", enum: ["plan", "edit"] }, confirmationToken,
    }, required: ["request"] },
  },
];
