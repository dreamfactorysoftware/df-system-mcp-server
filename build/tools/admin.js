"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAdminTools = registerAdminTools;
const define_1 = require("./define");
const zod_1 = require("zod");
const dreamfactory_1 = require("../dreamfactory");
/**
 * Administrator-user tools (/system/admin).
 *
 * DreamFactory distinguishes "admins" (full control-plane access) from regular users.
 * This module exposes read access; writes are intentionally limited — admin creation
 * tends to be a sensitive operation that should go through the orchestrator's
 * privileged path, not an LLM. Use call_system_api if you really need to write here.
 */
function registerAdminTools(server, opts) {
    (0, define_1.defineTool)(server, opts, "list_admins", "List all DreamFactory admin users. Returns id, email, first_name, last_name, is_active, " +
        "is_root_admin, last_login_date. Read-only — to create a new admin, use call_system_api with " +
        "method=POST and path=system/admin (and supply a generated password).", {
        filter: zod_1.z.string().optional().describe('SQL-like filter, e.g. "is_active=true".'),
        fields: zod_1.z.string().optional(),
        limit: zod_1.z.number().int().positive().optional(),
    }, async ({ filter, fields, limit }, extra) => {
        const auth = (0, dreamfactory_1.getAuthForSession)(extra.sessionId);
        // include_count + default limit=100 so the LLM gets `meta.count`.
        const result = await (0, dreamfactory_1.dreamFactoryFetch)("GET", "system/admin", {
            auth,
            query: {
                filter,
                fields,
                limit: limit ?? 100,
                include_count: true,
            },
        });
        return (0, dreamfactory_1.toToolResponse)("list_admins", result);
    });
}
//# sourceMappingURL=admin.js.map