"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerServiceTools = registerServiceTools;
const define_1 = require("./define");
const zod_1 = require("zod");
const dreamfactory_1 = require("../dreamfactory");
/**
 * Register the service-CRUD tool family on the given MCP server.
 *
 * These tools cover /system/service — the table that holds every DreamFactory
 * connector (databases, file storage, email, scripts, etc).
 */
function registerServiceTools(server, opts) {
    (0, define_1.defineTool)(server, opts, "list_services", "List all DreamFactory services (database connectors, file storage, email, scripts, etc) registered on the platform. " +
        "Returns id, name, label, type, is_active, and description for each. " +
        "Use the optional `filter` argument with SQL-like syntax (e.g. \"type=mysql\" or \"is_active=true\") to narrow the result set. " +
        "Use `fields` to project specific columns, and `limit` to cap result count. " +
        "Call this before creating a service to check for name collisions.", {
        filter: zod_1.z
            .string()
            .optional()
            .describe('SQL-like filter, e.g. "type=mysql" or "name LIKE %prod%".'),
        fields: zod_1.z
            .string()
            .optional()
            .describe('Comma-separated columns to return, e.g. "id,name,type,is_active".'),
        limit: zod_1.z.number().int().positive().optional().describe("Max records to return."),
    }, async ({ filter, fields, limit }, extra) => {
        const auth = (0, dreamfactory_1.getAuthForSession)(extra.sessionId);
        // include_count + default limit=100 so the LLM gets `meta.count`.
        const result = await (0, dreamfactory_1.dreamFactoryFetch)("GET", "system/service", {
            auth,
            query: {
                filter,
                fields,
                limit: limit ?? 100,
                include_count: true,
            },
        });
        return (0, dreamfactory_1.toToolResponse)("list_services", result);
    });
    (0, define_1.defineTool)(server, opts, "get_service", "Retrieve a single DreamFactory service by numeric id OR by name. " +
        "Returns full configuration including the `config` object (credentials, host, port, etc) " +
        "for that service type. Use this when you need to inspect or copy an existing service's config.", {
        id_or_name: zod_1.z.string().describe("Numeric id (e.g. \"7\") or service name (e.g. \"mysql-prod\")."),
    }, async ({ id_or_name }, extra) => {
        const auth = (0, dreamfactory_1.getAuthForSession)(extra.sessionId);
        const result = await (0, dreamfactory_1.dreamFactoryFetch)("GET", `system/service/${encodeURIComponent(id_or_name)}`, { auth });
        return (0, dreamfactory_1.toToolResponse)("get_service", result);
    });
    (0, define_1.defineTool)(server, opts, "create_service", "Create a new DreamFactory service (database connector, file storage, email, script, etc). " +
        "PREREQUISITE STEPS: " +
        "(1) Call `list_service_types` to learn what `type` values are valid (e.g. \"mysql\", \"pgsql\", \"local_file\"). " +
        "(2) Call `get_service_type_schema` with that type name to learn what shape the `config` object must have " +
        "(host, port, database, credentials etc differ per type). " +
        "After creation the service becomes addressable at /api/v2/{name}/. Returns the created service including its new id.", {
        name: zod_1.z
            .string()
            .describe("URL-safe identifier the service will be addressable by, e.g. \"mysql-prod\". Lowercase, no spaces."),
        label: zod_1.z.string().describe("Human-readable label shown in the admin UI."),
        type: zod_1.z
            .string()
            .describe('Service type slug from list_service_types, e.g. "mysql", "pgsql", "local_file".'),
        config: zod_1.z
            .record(zod_1.z.unknown())
            .optional()
            .describe("Type-specific configuration object. Shape varies by type — fetch get_service_type_schema first."),
        description: zod_1.z.string().optional(),
        is_active: zod_1.z.boolean().optional().default(true).describe("Whether the service is enabled."),
    }, async ({ name, label, type, config, description, is_active }, extra) => {
        const auth = (0, dreamfactory_1.getAuthForSession)(extra.sessionId);
        // DreamFactory expects { resource: [ {...} ] } for collection POSTs.
        const result = await (0, dreamfactory_1.dreamFactoryFetch)("POST", "system/service", {
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
        return (0, dreamfactory_1.toToolResponse)("create_service", result);
    });
    (0, define_1.defineTool)(server, opts, "update_service", "Patch an existing DreamFactory service. Only the fields you provide in `patch` are modified; " +
        "everything else is left alone. Commonly used to flip `is_active`, change `label`, or update " +
        "the `config` object (e.g. rotate credentials). Identify the service by numeric id or name.", {
        id_or_name: zod_1.z.string().describe("Numeric id or service name."),
        patch: zod_1.z
            .record(zod_1.z.unknown())
            .describe("Partial service object — only fields you want to change. May include nested `config`."),
    }, async ({ id_or_name, patch }, extra) => {
        const auth = (0, dreamfactory_1.getAuthForSession)(extra.sessionId);
        const result = await (0, dreamfactory_1.dreamFactoryFetch)("PATCH", `system/service/${encodeURIComponent(id_or_name)}`, { auth, body: patch });
        return (0, dreamfactory_1.toToolResponse)("update_service", result);
    });
    (0, define_1.defineTool)(server, opts, "delete_service", "Permanently delete a DreamFactory service. This unregisters the connector and removes the /api/v2/{name}/ " +
        "endpoint. Existing role_service_access entries referring to this service will be cascaded. " +
        "Use with care — there is no undo. Identify by numeric id or name.", {
        id_or_name: zod_1.z.string().describe("Numeric id or service name to delete."),
    }, async ({ id_or_name }, extra) => {
        const auth = (0, dreamfactory_1.getAuthForSession)(extra.sessionId);
        const result = await (0, dreamfactory_1.dreamFactoryFetch)("DELETE", `system/service/${encodeURIComponent(id_or_name)}`, { auth });
        return (0, dreamfactory_1.toToolResponse)("delete_service", result);
    });
}
//# sourceMappingURL=service.js.map