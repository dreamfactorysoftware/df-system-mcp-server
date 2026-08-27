import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerServiceTools } from "./service";
import { registerMetaTools } from "./meta";
import { registerRoleTools } from "./role";
import { registerAppTools } from "./app";
import { registerAdminTools } from "./admin";
import { registerGenericTools } from "./generic";

/**
 * Canonical list of every tool this server registers. Kept here for the /health
 * endpoint and for the smoke test, so we have one source of truth.
 */
export const TOOL_NAMES = [
  // services (5)
  "list_services",
  "get_service",
  "create_service",
  "update_service",
  "delete_service",
  // service types / environment (3)
  "list_service_types",
  "get_service_type_schema",
  "get_environment",
  // roles (4)
  "list_roles",
  "create_role",
  "get_role",
  "update_role",
  // apps (3)
  "list_apps",
  "create_app",
  "get_app",
  // admins (1)
  "list_admins",
  // escape hatch (1)
  "call_system_api",
] as const;

export const TOOL_COUNT = TOOL_NAMES.length;

/** Register every tool family on the MCP server. */
export function registerTools(server: McpServer): void {
  registerServiceTools(server);
  registerMetaTools(server);
  registerRoleTools(server);
  registerAppTools(server);
  registerAdminTools(server);
  registerGenericTools(server);
}
