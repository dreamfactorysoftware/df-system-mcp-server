import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, type RegisterToolOptions } from "./define";
import { z } from "zod";
import { dreamFactoryFetch, getAuthForSession, toToolResponse } from "../dreamfactory";

/**
 * Administrator-user tools (/system/admin).
 *
 * DreamFactory distinguishes "admins" (full control-plane access) from regular users.
 * This module exposes read access; writes are intentionally limited — admin creation
 * tends to be a sensitive operation that should go through the orchestrator's
 * privileged path, not an LLM. Use call_system_api if you really need to write here.
 */
export function registerAdminTools(server: McpServer, opts?: RegisterToolOptions): void {
  defineTool(
    server,
    opts,
    "list_admins",
    "List all DreamFactory admin users. Returns id, email, first_name, last_name, is_active, " +
      "is_root_admin, last_login_date. Read-only — to create a new admin, use call_system_api with " +
      "method=POST and path=system/admin (and supply a generated password).",
    {
      filter: z.string().optional().describe('SQL-like filter, e.g. "is_active=true".'),
      fields: z.string().optional(),
      limit: z.number().int().positive().optional(),
    },
    async ({ filter, fields, limit }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      // include_count + default limit=100 so the LLM gets `meta.count`.
      const result = await dreamFactoryFetch("GET", "system/admin", {
        auth,
        query: {
          filter,
          fields,
          limit: limit ?? 100,
          include_count: true,
        },
      });
      return toToolResponse("list_admins", result);
    },
  );
}
