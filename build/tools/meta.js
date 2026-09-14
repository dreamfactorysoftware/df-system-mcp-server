"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMetaTools = registerMetaTools;
const define_1 = require("./define");
const zod_1 = require("zod");
const dreamfactory_1 = require("../dreamfactory");
/**
 * Meta tools: service-type catalogue, schema introspection, environment info.
 * These are the "look before you leap" tools the LLM should call before
 * issuing destructive or creation calls.
 */
function registerMetaTools(server, opts) {
    (0, define_1.defineTool)(server, opts, "list_service_types", "List every service TYPE that DreamFactory can register (mysql, pgsql, mongodb, snowflake, local_file, s3, " +
        "smtp, script_php, etc). This is the catalogue of valid `type` values for create_service. " +
        "Use the optional `group` argument to filter by category (\"Database\", \"Big Data\", \"File\", " +
        "\"Email\", \"Script\", \"OAuth\", \"Auth\", \"Notification\", \"Remote Service\", \"Source Control\"). " +
        "After choosing a type, call get_service_type_schema for that type's config requirements.", {
        group: zod_1.z
            .string()
            .optional()
            .describe('Filter by category. Common values: "Database", "Big Data", "File", "Email", "Script", "OAuth".'),
    }, async ({ group }, extra) => {
        const auth = (0, dreamfactory_1.getAuthForSession)(extra.sessionId);
        const result = await (0, dreamfactory_1.dreamFactoryFetch)("GET", "system/service_type", {
            auth,
            query: group ? { group } : undefined,
        });
        return (0, dreamfactory_1.toToolResponse)("list_service_types", result);
    });
    (0, define_1.defineTool)(server, opts, "get_service_type_schema", "Fetch the configuration schema for a single service type (e.g. \"mysql\", \"snowflake\", \"s3\"). " +
        "Returns the type's metadata plus a `config_schema` array describing every field the `config` object " +
        "for that type accepts: field name, label, type, default, allowed values, whether required. " +
        "CRITICAL: call this before create_service so you know exactly what config the type wants.", {
        name: zod_1.z.string().describe('Service type slug, e.g. "mysql", "pgsql", "mongodb", "local_file", "s3".'),
    }, async ({ name }, extra) => {
        const auth = (0, dreamfactory_1.getAuthForSession)(extra.sessionId);
        const result = await (0, dreamfactory_1.dreamFactoryFetch)("GET", `system/service_type/${encodeURIComponent(name)}`, { auth });
        return (0, dreamfactory_1.toToolResponse)("get_service_type_schema", result);
    });
    (0, define_1.defineTool)(server, opts, "get_environment", "Return the DreamFactory environment summary: platform version, server software, available authentication " +
        "providers, server-side settings, and license details. Useful for: (a) confirming connectivity, " +
        "(b) discovering which DreamFactory edition (OSS/Gold) is running, (c) reading platform configuration " +
        "before deciding what features are usable. Read-only.", {}, async (_args, extra) => {
        const auth = (0, dreamfactory_1.getAuthForSession)(extra.sessionId);
        const result = await (0, dreamfactory_1.dreamFactoryFetch)("GET", "system/environment", { auth });
        return (0, dreamfactory_1.toToolResponse)("get_environment", result);
    });
}
//# sourceMappingURL=meta.js.map