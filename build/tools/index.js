"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_COUNT = exports.TOOL_NAMES = void 0;
exports.registerTools = registerTools;
const service_1 = require("./service");
const meta_1 = require("./meta");
const role_1 = require("./role");
const app_1 = require("./app");
const admin_1 = require("./admin");
const audit_1 = require("./audit");
const generic_1 = require("./generic");
/**
 * Canonical list of every tool this server registers. Kept here for the /health
 * endpoint and for the smoke test, so we have one source of truth.
 */
exports.TOOL_NAMES = [
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
    // access audit (1)
    "get_access_audit",
    // escape hatch (1)
    "call_system_api",
];
exports.TOOL_COUNT = exports.TOOL_NAMES.length;
/**
 * Register every tool family on the MCP server.
 * `opts.disabled` (from the DreamFactory service's `disabled_tools` config)
 * suppresses registration of the named tools; unknown names are ignored.
 */
function registerTools(server, opts) {
    (0, service_1.registerServiceTools)(server, opts);
    (0, meta_1.registerMetaTools)(server, opts);
    (0, role_1.registerRoleTools)(server, opts);
    (0, app_1.registerAppTools)(server, opts);
    (0, admin_1.registerAdminTools)(server, opts);
    (0, audit_1.registerAuditTools)(server, opts);
    (0, generic_1.registerGenericTools)(server, opts);
}
//# sourceMappingURL=index.js.map