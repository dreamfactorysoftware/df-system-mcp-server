import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";

/**
 * MCP tool annotations (readOnlyHint, destructiveHint, idempotentHint,
 * openWorldHint) derived from the tool name. Clients use them to decide what
 * needs confirmation, and tool-quality scorers treat a missing set as the
 * description having to carry the whole behavioral disclosure. Every tool here
 * talks to the DreamFactory instance only, so openWorldHint is always false.
 */
const EXPLICIT_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // Any verb on any system/user endpoint: the effect depends on the call.
  call_system_api: { readOnlyHint: false, openWorldHint: false },
  get_access_audit: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export function annotationsFor(name: string): ToolAnnotations {
  const explicit = EXPLICIT_ANNOTATIONS[name];
  if (explicit) return explicit;
  if (/^(list|get)_/.test(name)) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
  if (name.startsWith("delete_")) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
  if (name.startsWith("update_")) {
    // A patch can replace an access list or break a connector's config.
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
  if (name.startsWith("create_")) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  }
  return { readOnlyHint: false, openWorldHint: false };
}

/** Options threaded through every registerXxxTools call. */
export interface RegisterToolOptions {
  /** Tool names that must not be registered on this server instance. */
  disabled?: Set<string>;
}

/**
 * Register a tool unless its name is in `opts.disabled`.
 * Thin wrapper over `server.tool(name, description, schema, annotations, handler)`
 * so the per-service `disabled_tools` config can be honoured, and every tool
 * carries annotations, without touching every tool body. Returns true when
 * the tool was registered.
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
  server.tool(name, description, schema, annotationsFor(name), handler);
  return true;
}
