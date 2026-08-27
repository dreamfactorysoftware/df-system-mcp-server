import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools";

export const SERVER_NAME = "df-system-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Build a fresh McpServer with every control-plane tool registered.
 * Each MCP HTTP session gets its own instance so handlers can pull the right
 * sessionId from `extra.sessionId` and look up the bound DreamFactory token.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    capabilities: {
      tools: {},
      logging: {},
    },
  });
  registerTools(server);
  return server;
}
