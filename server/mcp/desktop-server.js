// "desktop" MCP server - exposes the local Windows desktop bridge as MCP tools.
// It is intentionally thin: Agentic OS keeps policy and confirmation gates, while
// the existing NOVA VOICE project remains the implementation source.
//
// stdout is the MCP protocol channel. Diagnostics must go to stderr.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const RUNNER = fileURLToPath(new URL("../../agentos-runtime/desktop-bridge/bridge_runner.py", import.meta.url));
const PYTHON = process.env.DESKTOP_BRIDGE_PYTHON || process.env.PYTHON || "python";

function run(command, params = {}) {
  const child = spawnSync(PYTHON, [RUNNER, command, JSON.stringify(params || {})], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  const raw = String(child.stdout || "").trim().split(/\r?\n/).pop() || "{}";
  let data = {};
  try { data = JSON.parse(raw); } catch { data = { ok: false, error: raw || child.error?.message || child.stderr || "Desktop bridge returned invalid JSON" }; }
  if (!data.ok) throw new Error(data.error || child.stderr || `Desktop bridge failed (${child.status})`);
  return data;
}

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const server = new McpServer({ name: "desktop", version: "1.0.0" });

server.registerTool(
  "desktop_status",
  { description: "Check whether the local NOVA VOICE desktop bridge is available on this machine.", inputSchema: {} },
  async () => {
    try {
      return text(run("status"));
    } catch (error) {
      return text({
        ok: false,
        available: false,
        error: error.message,
        python: PYTHON,
        novaVoiceHome: process.env.NOVA_VOICE_HOME || "C:\\NOVA VOICE",
      });
    }
  }
);

server.registerTool(
  "desktop_screen_process",
  {
    description: "Ask the local NOVA VOICE vision tool to inspect the screen or camera. Requires a local GUI/camera and user approval in MILA.",
    inputSchema: {
      angle: z.enum(["screen", "camera"]).default("screen"),
      text: z.string().min(1).max(1000).describe("Question or instruction about the current screen/camera frame."),
    },
  },
  async ({ angle, text: prompt }) => text(run("screen_process", { angle, text: prompt }))
);

server.registerTool(
  "desktop_control",
  {
    description: "Run a local NOVA VOICE desktop action such as list, stats, current_wallpaper, organize, clean, wallpaper, or task. Requires explicit user approval.",
    inputSchema: {
      action: z.string().max(80).optional(),
      task: z.string().max(2000).optional(),
      path: z.string().max(1000).optional(),
      url: z.string().max(2000).optional(),
      mode: z.string().max(80).optional(),
    },
  },
  async (params) => text(run("desktop_control", params))
);

server.registerTool(
  "computer_control",
  {
    description: "Run a local NOVA VOICE computer-control action: click, type, hotkey, scroll, screenshot, focus_window, screen_find and related UI automation. Requires explicit user approval.",
    inputSchema: {
      action: z.string().min(1).max(80),
      text: z.string().max(10000).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      x1: z.number().optional(),
      y1: z.number().optional(),
      x2: z.number().optional(),
      y2: z.number().optional(),
      keys: z.union([z.string(), z.array(z.string())]).optional(),
      key: z.string().max(80).optional(),
      direction: z.enum(["up", "down", "left", "right"]).optional(),
      amount: z.number().min(1).max(100).optional(),
      seconds: z.number().min(0).max(30).optional(),
      title: z.string().max(300).optional(),
      description: z.string().max(1000).optional(),
      type: z.string().max(80).optional(),
      field: z.string().max(120).optional(),
      clear_first: z.boolean().optional(),
      path: z.string().max(1000).optional(),
    },
  },
  async (params) => text(run("computer_control", params))
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[desktop] MCP server ready");
