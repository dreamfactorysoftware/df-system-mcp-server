"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveServiceId = resolveServiceId;
exports.registerServiceTools = registerServiceTools;
const define_1 = require("./define");
const zod_1 = require("zod");
const dreamfactory_1 = require("../dreamfactory");
/** Service names DreamFactory accepts; anything else can't be a name and is never put into a filter. */
const SERVICE_NAME = /^[A-Za-z0-9_.-]+$/;
/**
 * Resolve an `id_or_name` argument to a numeric service id. DreamFactory's
 * system/service/{id} only takes ids (a name there is a 404), so a name is
 * looked up with a `name='...'` filter first.
 */
async function resolveServiceId(idOrName, auth) {
    const value = idOrName.trim();
    if (/^\d+$/.test(value))
        return { id: value };
    if (!SERVICE_NAME.test(value)) {
        return {
            failure: {
                ok: false,
                status: 400,
                error: `invalid service id or name '${idOrName}': use the numeric id or the service name (letters, digits, _ . -)`,
            },
        };
    }
    const found = await (0, dreamfactory_1.dreamFactoryFetch)("GET", "system/service", {
        auth,
        query: { filter: `name='${value}'`, fields: "id,name" },
    });
    if (!found.ok)
        return { failure: found };
    const rows = found.data?.resource ?? [];
    const id = rows[0]?.id;
    if (typeof id !== "number" && typeof id !== "string") {
        return { failure: { ok: false, status: 404, error: `no service named '${value}'` } };
    }
    return { id: String(id) };
}
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
        "Returns full configuration including the `config` object (host, port, database, etc) " +
        "for that service type. Secret fields come back as \"**********\": passwords, client secrets, private keys, " +
        "tokens, header or parameter values with credential names (Authorization, Cookie, api_key, ...), credential " +
        "curl options, and passwords inside URLs. Other headers, parameters and options stay readable. Sending a " +
        "masked top-level config field back in update_service leaves the stored secret unchanged; headers, parameters " +
        "and options are stored as a whole, so send them with real values or leave them out. " +
        "Use this when you need to inspect or copy an existing service's config.", {
        id_or_name: zod_1.z.string().describe("Numeric id (e.g. \"7\") or service name (e.g. \"mysql-prod\")."),
    }, async ({ id_or_name }, extra) => {
        const auth = (0, dreamfactory_1.getAuthForSession)(extra.sessionId);
        const target = await resolveServiceId(id_or_name, auth);
        if ("failure" in target)
            return (0, dreamfactory_1.toToolResponse)("get_service", target.failure);
        const result = await (0, dreamfactory_1.dreamFactoryFetch)("GET", `system/service/${target.id}`, { auth });
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
        "the `config` object (e.g. rotate credentials). To rotate a credential, send the new value; any field set to " +
        "\"**********\" directly in `config` is dropped before the request, so the stored secret stays as it is. A " +
        "\"**********\" inside a list or nested value (RWS `headers`, `parameters`, `options`, which DreamFactory stores " +
        "as a whole) or inside a longer string is refused: send the real values, or omit that field to keep it. " +
        "Identify the service by numeric id or name.", {
        id_or_name: zod_1.z.string().describe("Numeric id or service name."),
        patch: zod_1.z
            .record(zod_1.z.unknown())
            .describe("Partial service object — only fields you want to change. May include nested `config`."),
    }, async ({ id_or_name, patch }, extra) => {
        const auth = (0, dreamfactory_1.getAuthForSession)(extra.sessionId);
        const target = await resolveServiceId(id_or_name, auth);
        if ("failure" in target)
            return (0, dreamfactory_1.toToolResponse)("update_service", target.failure);
        const result = await (0, dreamfactory_1.dreamFactoryFetch)("PATCH", `system/service/${target.id}`, { auth, body: patch });
        return (0, dreamfactory_1.toToolResponse)("update_service", result);
    });
    (0, define_1.defineTool)(server, opts, "delete_service", "Permanently delete a DreamFactory service. This unregisters the connector and removes the /api/v2/{name}/ " +
        "endpoint. Existing role_service_access entries referring to this service will be cascaded. " +
        "Use with care — there is no undo. Identify by numeric id or name.", {
        id_or_name: zod_1.z.string().describe("Numeric id or service name to delete."),
    }, async ({ id_or_name }, extra) => {
        const auth = (0, dreamfactory_1.getAuthForSession)(extra.sessionId);
        const target = await resolveServiceId(id_or_name, auth);
        if ("failure" in target)
            return (0, dreamfactory_1.toToolResponse)("delete_service", target.failure);
        const result = await (0, dreamfactory_1.dreamFactoryFetch)("DELETE", `system/service/${target.id}`, { auth });
        return (0, dreamfactory_1.toToolResponse)("delete_service", result);
    });
}
//# sourceMappingURL=service.js.map