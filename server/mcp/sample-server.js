// A real, self-contained MCP server (stdio) bundled with Agentic OS so MCP works
// out-of-the-box with zero network/downloads. Exposes a few demo tools.
//
// IMPORTANT: never write to stdout here except via the transport — stdout is the
// MCP protocol channel. Use console.error (stderr) for any diagnostics.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "sample-tools", version: "1.0.0" });

server.registerTool(
  "echo",
  { description: "Echo back the provided text.", inputSchema: { text: z.string().describe("Text to echo") } },
  async ({ text }) => ({ content: [{ type: "text", text }] })
);

server.registerTool(
  "add",
  { description: "Add two numbers and return the sum.", inputSchema: { a: z.number(), b: z.number() } },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] })
);

server.registerTool(
  "server_time",
  { description: "Return the current server time as an ISO 8601 string.", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: new Date().toISOString() }] })
);

const FACTS = [
  "Agents work best with clear tools and tight guardrails.",
  "MCP lets an agent discover tools at runtime over a simple protocol.",
  "Short, idempotent tools are safer to retry than long stateful ones.",
  "Evaluations turn 'it feels good' into a number you can track.",
];
server.registerTool(
  "random_agent_fact",
  { description: "Return a random fact about building AI agents.", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: FACTS[Math.floor(Math.random() * FACTS.length)] }] })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[sample-tools] MCP server ready on stdio");
