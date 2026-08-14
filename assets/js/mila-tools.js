const confirmationToken = {
  type: "string",
  description: "One-time token returned when this exact action was staged. Omit it on the first call; reuse it only after the user explicitly confirms.",
};

// The owner's own desk: the day plan, personal tasks, notes, reminders and the
// calendar. Everything here is scoped to the signed-in account by the server, so
// a Member gets these too — they only ever reach their own data.
export const MILA_PERSONAL_TOOLS = [
  {
    name: "get_my_day_plan",
    description: "Read the live plan for today: calendar events, focus blocks built from open tasks, alerts (overdue tasks, meeting clashes, pending approvals, ERP flags) and free time. Use this for any question about the day, the schedule, what is next, or what to do now — never answer those from memory.",
    parameters: { type: "object", properties: {
      refresh: { type: "boolean", description: "Force a fresh ERP read instead of the cached digest" },
    } },
  },
  {
    name: "list_my_tasks",
    description: "List the owner's personal tasks. These are private, unlike Kanban tasks which belong to the Hermes agent team.",
    parameters: { type: "object", properties: {
      status: { type: "string", enum: ["todo", "doing", "done"] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    } },
  },
  {
    name: "create_my_task",
    description: "Add a personal task for the owner. Runs immediately without confirmation: it is private capture the owner can undo in one click.",
    parameters: { type: "object", properties: {
      title: { type: "string" }, detail: { type: "string" },
      priority: { type: "string", enum: ["low", "normal", "high"] },
      dueDate: { type: "string", description: "Due date as YYYY-MM-DD" },
      status: { type: "string", enum: ["todo", "doing"] },
    }, required: ["title"] },
  },
  {
    name: "update_my_task",
    description: "Change a personal task: mark it done, move its due date, or change its priority.",
    parameters: { type: "object", properties: {
      taskId: { type: "string" }, title: { type: "string" }, detail: { type: "string" },
      status: { type: "string", enum: ["todo", "doing", "done"] },
      priority: { type: "string", enum: ["low", "normal", "high"] },
      dueDate: { type: "string", description: "Due date as YYYY-MM-DD, or an empty string to clear it" },
    }, required: ["taskId"] },
  },
  {
    name: "list_my_notes",
    description: "Read the owner's private notes, optionally filtered by a search term.",
    parameters: { type: "object", properties: {
      query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 },
    } },
  },
  {
    name: "save_my_note",
    description: "Save a private note for the owner — a decision, a phone number, something said in passing worth keeping. Runs immediately.",
    parameters: { type: "object", properties: {
      title: { type: "string" }, content: { type: "string" },
    }, required: ["title", "content"] },
  },
  {
    name: "remind_me",
    description: "Set a reminder that fires at a specific moment and arrives in the inbox and as a phone notification. Use this for 'напомни мне в 15:00' or 'через час'. Always compute the absolute time from the current local time given in your instructions.",
    parameters: { type: "object", properties: {
      title: { type: "string", description: "What to remind about, in the owner's language" },
      body: { type: "string" },
      dueAt: { type: "string", description: "Absolute ISO 8601 timestamp with offset, for example 2026-08-10T15:00:00+05:00" },
      priority: { type: "string", enum: ["normal", "high"] },
    }, required: ["title", "dueAt"] },
  },
  {
    name: "list_my_reminders",
    description: "List reminders that have not fired yet.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "cancel_reminder",
    description: "Cancel a pending reminder by id.",
    parameters: { type: "object", properties: { reminderId: { type: "string" } }, required: ["reminderId"] },
  },
  {
    name: "remember_about_me",
    description: "Remember one fact the owner told you about themselves — a person they work with and how, a preference, a standing commitment, a date that matters. Only ever record what they actually said or confirmed: never your own conclusions about them, and never something you inferred from their behaviour. Runs immediately; say back what you wrote.",
    parameters: { type: "object", properties: {
      fact: { type: "string", description: "One short sentence, in the owner's own words where possible" },
      category: { type: "string", enum: ["people", "preferences", "commitments", "dates", "other"] },
    }, required: ["fact"] },
  },
  {
    name: "read_about_me",
    description: "Read what the owner has told you about themselves. Use it to be genuinely useful — remembering how someone prefers to be contacted, or what they always do on a Monday — and never repeat any of it to anyone else.",
    parameters: { type: "object", properties: {
      category: { type: "string", enum: ["people", "preferences", "commitments", "dates", "other"] },
    } },
  },
  {
    name: "forget_about_me",
    description: "Remove one fact from the personal profile, by id, when the owner asks you to forget it or says it is wrong.",
    parameters: { type: "object", properties: {
      factId: { type: "string" },
    }, required: ["factId"] },
  },
  {
    name: "send_telegram",
    description: "Send text to the owner's own linked Telegram — a summary, a plan, a number they asked to have at hand. Their chat only: there is no way to send to anyone else's. If it comes back linked:false, tell them to link Telegram on the Personal page first.",
    parameters: { type: "object", properties: {
      text: { type: "string", description: "What to deliver, ready to read in a chat" },
    }, required: ["text"] },
  },
  {
    name: "list_my_calendar",
    description: "Read real Google Calendar events in a time range. Use it before proposing a meeting time so you never double-book.",
    parameters: { type: "object", properties: {
      from: { type: "string", description: "ISO 8601 start of the range, defaults to now" },
      to: { type: "string", description: "ISO 8601 end of the range, defaults to a week ahead" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    } },
  },
  {
    name: "create_calendar_event",
    description: "Stage or confirm a new Google Calendar event. Always uses two-step confirmation, because a calendar entry can involve other people.",
    parameters: { type: "object", properties: {
      title: { type: "string" },
      start: { type: "string", description: "ISO 8601 start with offset" },
      end: { type: "string", description: "ISO 8601 end with offset; defaults to one hour after the start" },
      description: { type: "string" }, location: { type: "string" },
      timeZone: { type: "string", description: "IANA zone such as Asia/Tashkent" },
      allDay: { type: "boolean" }, confirmationToken,
    }, required: ["title", "start"] },
  },
  {
    name: "reschedule_calendar_event",
    description: "Stage or confirm moving an existing calendar event to a new time. Two-step confirmation.",
    parameters: { type: "object", properties: {
      eventId: { type: "string" }, start: { type: "string" }, end: { type: "string" },
      title: { type: "string" }, timeZone: { type: "string" }, confirmationToken,
    }, required: ["eventId", "start"] },
  },
  {
    name: "cancel_calendar_event",
    description: "Stage or confirm deleting a calendar event. Two-step confirmation, and it is not reversible.",
    parameters: { type: "object", properties: {
      eventId: { type: "string" }, confirmationToken,
    }, required: ["eventId"] },
  },
];

// The company knowledge base. These pages cannot live in the prompt — it holds
// 9000 characters and the playbook alone already overruns it — so MILA carries
// an index and looks the page up when asked. Reading is company-wide; writing is
// operator-only and confirmed, because everyone quotes these pages afterwards.
export const MILA_KNOWLEDGE_TOOLS = [
  {
    name: "search_company_knowledge",
    description: "Search the Milana company knowledge base: prices and terms, fabrics and size charts, export rules per country, who is responsible for what, and standard answers to customer questions. Use this before answering any question about the business that is not live ERP data.",
    parameters: { type: "object", properties: {
      query: { type: "string", description: "What to look for, in the user's own words" },
    }, required: ["query"] },
  },
  {
    name: "read_company_knowledge",
    description: "Read one whole page of the company knowledge base.",
    parameters: { type: "object", properties: {
      page: { type: "string", enum: ["products-and-prices", "who-does-what", "export-by-country", "customer-questions"] },
    }, required: ["page"] },
  },
  {
    name: "list_company_knowledge",
    description: "List the pages of the company knowledge base and what each one holds.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "save_company_knowledge",
    description: "Stage or confirm writing one fact into the company knowledge base, so it is available to everyone next time. Use it when the owner tells you something worth keeping — a price, a term, a rule. Two-step confirmation: read the exact wording back first, because everyone will quote it afterwards.",
    parameters: { type: "object", properties: {
      page: { type: "string", enum: ["products-and-prices", "who-does-what", "export-by-country", "customer-questions"] },
      section: { type: "string", description: "Heading inside that page, when you know it" },
      fact: { type: "string", description: "One short quotable sentence" },
      confirmationToken,
    }, required: ["page", "fact"] },
  },
];

export const MILA_TOOLS = [
  ...MILA_PERSONAL_TOOLS,
  ...MILA_KNOWLEDGE_TOOLS,
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
    name: "learn_skill",
    description: "Teach the Hermes fleet a procedure: the operator describes how something is done — or gives feedback on an existing skill by name — and you install it as a structured skill after confirmation. Two-step: the first call stages a draft and returns a confirmation token with a summary; repeat with confirmationToken to install.",
    parameters: { type: "object", properties: {
      instruction: { type: "string", description: "The process description or feedback, in the operator's words" },
      name: { type: "string", description: "Existing skill name to refine; omit to create a new one" },
      profile: { type: "string", enum: ["default", "scout", "scribe", "reach", "dev"], description: "Fleet profile to attach the skill to" },
      confirmationToken: { type: "string" },
    }, required: [] },
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
    name: "get_sewing_daily_report",
    description: "The daily sewing report for one date and factory: per-line output plus flow capacity — the same data as the ERP page /sewing/daily-report. Use it for questions about сегодняшняя/вчерашняя выработка швейных цехов. If ok is false, read error.message aloud (usually a missing ERP permission) and never invent output numbers.",
    parameters: { type: "object", properties: {
      reportDate: { type: "string", description: "YYYY-MM-DD; omit for today" },
      factoryCode: { type: "string", description: "Factory code, default MIL" },
    } },
  },
  {
    name: "get_erp_business_context",
    description: "Read live Milana ERP business context for questions about production, cutting, sewing flow load, warehouse ETA, finished-goods stock from /warehouse-stock and /warehouse-map, material inventory, finance and operational risks.",
    parameters: { type: "object", properties: {
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum rows for ERP control sections" },
    } },
  },
  {
    name: "get_finished_goods_stock",
    description: "Read the exact live finished-goods / ready-product warehouse stock from /warehouse-stock and /warehouse-map. Use this first for questions like 'сколько готовых изделий на складе', 'готовая продукция', 'ready product stock', 'finished goods', locations, packages, model and warehouse map cells.",
    parameters: { type: "object", properties: {
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum finished-goods rows or packages to include" },
    } },
  },
  {
    name: "get_erp_late_orders",
    description: "Read orders that are already behind schedule in Milana ERP. Use this for questions about delays, at-risk orders and what is slipping.",
    parameters: { type: "object", properties: {
      limit: { type: "integer", minimum: 1, maximum: 50 },
    } },
  },
  {
    name: "list_erp_employee_tasks",
    description: "Read real tasks assigned to staff in Milana ERP, optionally filtered by employee id, department or status. Use it to answer who is doing what, not to guess.",
    parameters: { type: "object", properties: {
      employee: { type: "string", description: "ERP user id of the employee" },
      department: { type: "string" },
      status: { type: "string" },
      scope: { type: "string", description: "all or mine; defaults to all" },
    } },
  },
  {
    name: "create_erp_task",
    description: "Stage or confirm a real task for a Milana employee in ERP. Two-step confirmation: this assigns work to a real person, so state the assignee, the title and the due date back before confirming.",
    parameters: { type: "object", properties: {
      title: { type: "string" }, description: { type: "string" },
      assigneeUserId: { type: "integer", description: "ERP user id of the assignee" },
      department: { type: "string", description: "Use instead of an assignee to give the task to a department" },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      dueDate: { type: "string", description: "Due date as YYYY-MM-DD" },
      confirmationToken,
    }, required: ["title"] },
  },
  {
    name: "send_erp_notification",
    description: "Stage or confirm sending a notification to real Milana staff through ERP. Two-step confirmation, and it cannot be recalled: read the recipient and the full text back before confirming.",
    parameters: { type: "object", properties: {
      targetType: { type: "string", enum: ["user", "department", "safe_group"] },
      userId: { type: "integer", description: "ERP user id when targetType is user" },
      department: { type: "string" }, safeGroup: { type: "string" },
      title: { type: "string" }, message: { type: "string" }, link: { type: "string" },
      confirmationToken,
    }, required: ["targetType", "title"] },
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

// Everything a Member's Mila Live call is allowed to do: their own desk, plus the
// same live ERP data the ERP panel already shows them. No Kanban, Hermes, Obsidian,
// Claude Code or MCP tool — the server enforces this too (server/routes/mila-actions.js),
// this list only keeps the model from offering actions it cannot actually perform.
export const MILA_MEMBER_TOOLS = MILA_TOOLS.filter((tool) =>
  ["get_erp_business_context", "get_finished_goods_stock", "get_sewing_daily_report"].includes(tool.name)
  || MILA_PERSONAL_TOOLS.some((personal) => personal.name === tool.name)
  // Reading company knowledge, but not writing it: an employee looking up the
  // minimum order is the point, an employee rewriting it is not.
  || (MILA_KNOWLEDGE_TOOLS.some((item) => item.name === tool.name) && tool.name !== "save_company_knowledge"));
