import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";

/** Options threaded through every registerXxxTools call. */
export interface RegisterToolOptions {
  /** Tool names that must not be registered on this server instance. */
  disabled?: Set<string>;
}

/**
 * Register a tool unless its name is in `opts.disabled`.
 * Thin wrapper over `server.tool(name, description, schema, handler)` so the
 * per-service `disabled_tools` config can be honoured without touching every
 * tool body. Returns true when the tool was registered.
 */
export function defineTool<Args extends ZodRawShape>(
  server: McpServer,
  opts: RegisterToolOptions | undefined,
  name: string,
  description: string,
  schema: Args,
  handler: ToolCallback<Args>,
): boolean {
  if (opts?.disabled?.has(name)) return false;
  server.tool(name, description, schema, handler);
  return true;
}
