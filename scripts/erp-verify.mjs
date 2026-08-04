#!/usr/bin/env node
import process from "node:process";
import { config } from "../server/config.js";
import { db } from "../server/store.js";
import * as mcp from "../server/mcp/manager.js";

const server = db.mcp.get("mcp_erp");
if (!server) {
  console.error("Milana ERP MCP server is not registered.");
  process.exit(1);
}

console.log(`ERP base URL: ${config.erp.baseUrl}`);
if (!config.erp.bearerToken) {
  console.error("ERP_MCP_BEARER_TOKEN is missing. Add it to .env before running a live ERP check.");
  process.exit(1);
}

try {
  const { tools } = await mcp.connect(server);
  console.log(`MCP connected. Tools: ${tools.map((tool) => tool.name).join(", ")}`);
  const result = await mcp.callTool("mcp_erp", "erp_me", {});
  const text = result?.content?.find((item) => item.type === "text")?.text || "";
  console.log("erp_me result:");
  console.log(text);
  if (/\"ok\"\s*:\s*false/.test(text)) process.exitCode = 1;
} finally {
  await mcp.disconnect("mcp_erp");
}
