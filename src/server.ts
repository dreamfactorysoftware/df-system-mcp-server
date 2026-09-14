import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, TOOL_NAMES } from "./tools";
import type { McpServiceConfig } from "./types";

export const SERVER_NAME = "df-system-mcp";
export const SERVER_VERSION = "0.5.0";

let warnedCustomTools = false;

/**
 * Normalise the `disabled_tools` value from a DreamFactory service config into
 * a Set of known tool names. Accepts an array of strings (or a JSON string of
 * one, or a comma-separated string) — unknown names are dropped silently.
 */
export function resolveDisabledTools(config?: McpServiceConfig | null): Set<string> {
  const out = new Set<string>();
  if (!config) return out;
  let raw: unknown = config.disabled_tools;
  if (typeof raw === "string") {
    const str = raw;
    try {
      raw = JSON.parse(str);
    } catch {
      raw = str.split(",");
    }
  }
  if (!Array.isArray(raw)) return out;
  const known = new Set<string>(TOOL_NAMES);
  for (const v of raw) {
    if (typeof v === "string") {
      const name = v.trim();
      if (known.has(name)) out.add(name);
    }
  }
  return out;
}

/**
 * Build a fresh McpServer with every control-plane tool registered, minus any
 * listed in the service config's `disabled_tools`.
 * Each MCP HTTP session gets its own instance so handlers can pull the right
 * sessionId from `extra.sessionId` and look up the bound DreamFactory token.
 */
export function buildMcpServer(config?: McpServiceConfig | null): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    capabilities: {
      tools: {},
      logging: {},
    },
  });
  if (config && Array.isArray(config.custom_tools) && config.custom_tools.length > 0 && !warnedCustomTools) {
    warnedCustomTools = true;
    console.debug("[df-system-mcp] custom_tools present in service config; ignored by the System API MCP server");
  }
  registerTools(server, { disabled: resolveDisabledTools(config) });
  return server;
}
