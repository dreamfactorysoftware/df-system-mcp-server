import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, type RegisterToolOptions } from "./define";
import { z } from "zod";
import { dreamFactoryFetch, getAuthForSession, toToolResponse } from "../dreamfactory";

/**
 * Register the service-CRUD tool family on the given MCP server.
 *
 * These tools cover /system/service — the table that holds every DreamFactory
 * connector (databases, file storage, email, scripts, etc).
 */
export function registerServiceTools(server: McpServer, opts?: RegisterToolOptions): void {
  defineTool(
    server,
    opts,
    "list_services",
    "List all DreamFactory services (database connectors, file storage, email, scripts, etc) registered on the platform. " +
      "Returns id, name, label, type, is_active, and description for each. " +
      "Use the optional `filter` argument with SQL-like syntax (e.g. \"type=mysql\" or \"is_active=true\") to narrow the result set. " +
      "Use `fields` to project specific columns, and `limit` to cap result count. " +
      "Call this before creating a service to check for name collisions.",
    {
      filter: z
        .string()
        .optional()
        .describe('SQL-like filter, e.g. "type=mysql" or "name LIKE %prod%".'),
      fields: z
        .string()
        .optional()
        .describe('Comma-separated columns to return, e.g. "id,name,type,is_active".'),
      limit: z.number().int().positive().optional().describe("Max records to return."),
    },
    async ({ filter, fields, limit }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      // include_count + default limit=100 so the LLM gets `meta.count`.
      const result = await dreamFactoryFetch("GET", "system/service", {
        auth,
        query: {
          filter,
          fields,
          limit: limit ?? 100,
          include_count: true,
        },
      });
      return toToolResponse("list_services", result);
    },
  );

  defineTool(
    server,
    opts,
    "get_service",
    "Retrieve a single DreamFactory service by numeric id OR by name. " +
      "Returns full configuration including the `config` object (host, port, database, etc) " +
      "for that service type. Secret fields (passwords, client secrets, private keys, tokens) come back as " +
      "\"**********\"; sending that value back in update_service leaves the stored secret unchanged. " +
      "Use this when you need to inspect or copy an existing service's config.",
    {
      id_or_name: z.string().describe("Numeric id (e.g. \"7\") or service name (e.g. \"mysql-prod\")."),
    },
    async ({ id_or_name }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      const result = await dreamFactoryFetch(
        "GET",
        `system/service/${encodeURIComponent(id_or_name)}`,
        { auth },
      );
      return toToolResponse("get_service", result);
    },
  );

  defineTool(
    server,
    opts,
    "create_service",
    "Create a new DreamFactory service (database connector, file storage, email, script, etc). " +
      "PREREQUISITE STEPS: " +
      "(1) Call `list_service_types` to learn what `type` values are valid (e.g. \"mysql\", \"pgsql\", \"local_file\"). " +
      "(2) Call `get_service_type_schema` with that type name to learn what shape the `config` object must have " +
      "(host, port, database, credentials etc differ per type). " +
      "After creation the service becomes addressable at /api/v2/{name}/. Returns the created service including its new id.",
    {
      name: z
        .string()
        .describe(
          "URL-safe identifier the service will be addressable by, e.g. \"mysql-prod\". Lowercase, no spaces.",
        ),
      label: z.string().describe("Human-readable label shown in the admin UI."),
      type: z
        .string()
        .describe('Service type slug from list_service_types, e.g. "mysql", "pgsql", "local_file".'),
      config: z
        .record(z.unknown())
        .optional()
        .describe(
          "Type-specific configuration object. Shape varies by type — fetch get_service_type_schema first.",
        ),
      description: z.string().optional(),
      is_active: z.boolean().optional().default(true).describe("Whether the service is enabled."),
    },
    async ({ name, label, type, config, description, is_active }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      // DreamFactory expects { resource: [ {...} ] } for collection POSTs.
      const result = await dreamFactoryFetch("POST", "system/service", {
        auth,
        body: {
          resource: [
            {
              name,
              label,
              type,
              description,
              is_active,
              config: config ?? {},
            },
          ],
        },
      });
      return toToolResponse("create_service", result);
    },
  );

  defineTool(
    server,
    opts,
    "update_service",
    "Patch an existing DreamFactory service. Only the fields you provide in `patch` are modified; " +
      "everything else is left alone. Commonly used to flip `is_active`, change `label`, or update " +
      "the `config` object (e.g. rotate credentials). To rotate a credential, send the new value; any field set to " +
      "\"**********\" is dropped before the request, so the stored secret stays as it is. " +
      "Identify the service by numeric id or name.",
    {
      id_or_name: z.string().describe("Numeric id or service name."),
      patch: z
        .record(z.unknown())
        .describe("Partial service object — only fields you want to change. May include nested `config`."),
    },
    async ({ id_or_name, patch }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      const result = await dreamFactoryFetch(
        "PATCH",
        `system/service/${encodeURIComponent(id_or_name)}`,
        { auth, body: patch },
      );
      return toToolResponse("update_service", result);
    },
  );

  defineTool(
    server,
    opts,
    "delete_service",
    "Permanently delete a DreamFactory service. This unregisters the connector and removes the /api/v2/{name}/ " +
      "endpoint. Existing role_service_access entries referring to this service will be cascaded. " +
      "Use with care — there is no undo. Identify by numeric id or name.",
    {
      id_or_name: z.string().describe("Numeric id or service name to delete."),
    },
    async ({ id_or_name }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      const result = await dreamFactoryFetch(
        "DELETE",
        `system/service/${encodeURIComponent(id_or_name)}`,
        { auth },
      );
      return toToolResponse("delete_service", result);
    },
  );
}
