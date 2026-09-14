import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, type RegisterToolOptions } from "./define";
import { z } from "zod";
import { dreamFactoryFetch, getAuthForSession, toToolResponse } from "../dreamfactory";

/**
 * Meta tools: service-type catalogue, schema introspection, environment info.
 * These are the "look before you leap" tools the LLM should call before
 * issuing destructive or creation calls.
 */
export function registerMetaTools(server: McpServer, opts?: RegisterToolOptions): void {
  defineTool(
    server,
    opts,
    "list_service_types",
    "List every service TYPE that DreamFactory can register (mysql, pgsql, mongodb, snowflake, local_file, s3, " +
      "smtp, script_php, etc). This is the catalogue of valid `type` values for create_service. " +
      "Use the optional `group` argument to filter by category (\"Database\", \"Big Data\", \"File\", " +
      "\"Email\", \"Script\", \"OAuth\", \"Auth\", \"Notification\", \"Remote Service\", \"Source Control\"). " +
      "After choosing a type, call get_service_type_schema for that type's config requirements.",
    {
      group: z
        .string()
        .optional()
        .describe(
          'Filter by category. Common values: "Database", "Big Data", "File", "Email", "Script", "OAuth".',
        ),
    },
    async ({ group }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      const result = await dreamFactoryFetch("GET", "system/service_type", {
        auth,
        query: group ? { group } : undefined,
      });
      // Type metadata only (no instance values); masking would corrupt config_schema descriptors.
      return toToolResponse("list_service_types", result, { unmasked: true });
    },
  );

  defineTool(
    server,
    opts,
    "get_service_type_schema",
    "Fetch the configuration schema for a single service type (e.g. \"mysql\", \"snowflake\", \"s3\"). " +
      "Returns the type's metadata plus a `config_schema` array describing every field the `config` object " +
      "for that type accepts: field name, label, type, default, allowed values, whether required. " +
      "CRITICAL: call this before create_service so you know exactly what config the type wants.",
    {
      name: z.string().describe('Service type slug, e.g. "mysql", "pgsql", "mongodb", "local_file", "s3".'),
    },
    async ({ name }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      const result = await dreamFactoryFetch(
        "GET",
        `system/service_type/${encodeURIComponent(name)}`,
        { auth },
      );
      // Type metadata only (no instance values); masking would corrupt config_schema descriptors.
      return toToolResponse("get_service_type_schema", result, { unmasked: true });
    },
  );

  defineTool(
    server,
    opts,
    "get_environment",
    "Return the DreamFactory environment summary: platform version, server software, available authentication " +
      "providers, server-side settings, and license details (the license key itself is masked as \"**********\"). " +
      "Useful for: (a) confirming connectivity, " +
      "(b) discovering which DreamFactory edition (OSS/Gold) is running, (c) reading platform configuration " +
      "before deciding what features are usable. Read-only.",
    {},
    async (_args, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      const result = await dreamFactoryFetch("GET", "system/environment", { auth });
      return toToolResponse("get_environment", result);
    },
  );
}
