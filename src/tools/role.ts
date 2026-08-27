import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, type RegisterToolOptions } from "./define";
import { z } from "zod";
import { dreamFactoryFetch, getAuthForSession, toToolResponse } from "../dreamfactory";

/**
 * Role and role_service_access tools.
 *
 * Roles in DreamFactory are NOT just labels — they own per-service, per-component,
 * per-HTTP-verb access masks via the related `role_service_access_by_role_id` collection.
 * An API key (app) without a role grants no access; the role's access entries are the gate.
 */
export function registerRoleTools(server: McpServer, opts?: RegisterToolOptions): void {
  // Schema for a single role_service_access entry. Mirrors the DB table.
  const accessEntry = z
    .object({
      service_id: z.number().int().describe("The id of the service this access rule applies to."),
      component: z
        .string()
        .default("*")
        .describe(
          'Component path on the service, e.g. "*" for all, "_table/*" for all tables, or "_table/customers".',
        ),
      verb_mask: z
        .number()
        .int()
        .describe(
          "Bitmask of allowed HTTP verbs. GET=1, POST=2, PUT=4, PATCH=8, DELETE=16. Sum them for combos (e.g. 31 = all).",
        ),
      requestor_mask: z
        .number()
        .int()
        .default(3)
        .describe("1 = API only, 2 = Script only, 3 = both. Almost always 3."),
      filters: z.array(z.record(z.unknown())).optional().describe("Row-level filter rules (advanced)."),
      filter_op: z.enum(["AND", "OR"]).optional(),
    })
    .describe("One row in role_service_access — a single permission grant.");

  defineTool(
    server,
    opts,
    "list_roles",
    "List all DreamFactory roles. Roles bundle a set of per-service permissions (via role_service_access). " +
      "Returns id, name, description, is_active for each. Use `filter` to narrow (e.g. \"is_active=true\").",
    {
      filter: z.string().optional().describe('SQL-like filter, e.g. "is_active=true".'),
      fields: z.string().optional().describe("Comma-separated columns to return."),
      limit: z.number().int().positive().optional(),
    },
    async ({ filter, fields, limit }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      // Always request include_count so the LLM gets `meta.count` — answers
      // "how many roles" without needing pagination. Default limit raised to
      // 100 because DreamFactory's default page size is 31 (or whatever
      // database.max_records_returned is set to) and the model otherwise
      // sees a truncated list and may hallucinate counts.
      const result = await dreamFactoryFetch("GET", "system/role", {
        auth,
        query: {
          filter,
          fields,
          limit: limit ?? 100,
          include_count: true,
        },
      });
      return toToolResponse("list_roles", result);
    },
  );

  defineTool(
    server,
    opts,
    "get_role",
    "Retrieve a single role by id, INCLUDING its full role_service_access list (the permission rows). " +
      "Use this when you need to read what a role actually grants — the bare role record only carries metadata.",
    {
      id: z.number().int().describe("Numeric role id."),
    },
    async ({ id }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      const result = await dreamFactoryFetch("GET", `system/role/${id}`, {
        auth,
        query: { related: "role_service_access_by_role_id" },
      });
      return toToolResponse("get_role", result);
    },
  );

  defineTool(
    server,
    opts,
    "create_role",
    "Create a new DreamFactory role with optional inline service-access grants. " +
      "To grant permissions atomically with role creation, pass `role_service_access_by_role_id` " +
      "as an array of access entries; the platform will insert them in a single transaction. " +
      "Each access entry needs service_id, component, and verb_mask (bitmask: GET=1, POST=2, PUT=4, PATCH=8, DELETE=16).",
    {
      name: z.string().describe('Human-readable role name, e.g. "ReadOnlyReports".'),
      description: z.string().optional(),
      is_active: z.boolean().optional().default(true),
      role_service_access_by_role_id: z
        .array(accessEntry)
        .optional()
        .describe("Inline access grants. If omitted, the role is created with NO permissions."),
    },
    async ({ name, description, is_active, role_service_access_by_role_id }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      const result = await dreamFactoryFetch("POST", "system/role", {
        auth,
        query: { related: "role_service_access_by_role_id", fields: "*" },
        body: {
          resource: [
            {
              name,
              description,
              is_active,
              role_service_access_by_role_id: role_service_access_by_role_id ?? [],
            },
          ],
        },
      });
      return toToolResponse("create_role", result);
    },
  );

  defineTool(
    server,
    opts,
    "update_role",
    "Patch an existing role. To add/remove permission rows, include `role_service_access_by_role_id` " +
      "in the patch as the FULL desired list (DreamFactory replaces the collection wholesale). " +
      "To merely flip is_active or change description, omit that key.",
    {
      id: z.number().int().describe("Numeric role id."),
      patch: z
        .record(z.unknown())
        .describe(
          "Partial role object. May include nested role_service_access_by_role_id to replace the access list.",
        ),
    },
    async ({ id, patch }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      const result = await dreamFactoryFetch("PATCH", `system/role/${id}`, {
        auth,
        query: { related: "role_service_access_by_role_id", fields: "*" },
        body: patch,
      });
      return toToolResponse("update_role", result);
    },
  );
}
