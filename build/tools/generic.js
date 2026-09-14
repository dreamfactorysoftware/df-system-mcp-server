"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGenericTools = registerGenericTools;
const define_1 = require("./define");
const zod_1 = require("zod");
const dreamfactory_1 = require("../dreamfactory");
const path_guard_1 = require("../path-guard");
const redact_1 = require("../redact");
/**
 * Generic escape hatch: lets the LLM hit any DreamFactory system/* or user/* endpoint
 * that isn't covered by a dedicated tool above. Defense-in-depth path restriction —
 * the real authorisation gate is server-side RBAC on the session token.
 */
function registerGenericTools(server, opts) {
    (0, define_1.defineTool)(server, opts, "call_system_api", "ESCAPE HATCH — call any DreamFactory system/* or user/* endpoint that the dedicated tools above don't cover. " +
        "Prefer the dedicated tools when available (they have richer descriptions and validation). " +
        "Use this for: less common system endpoints (system/cors, system/email_template, system/event, system/script_type, " +
        "system/lookup, system/cache, system/custom, system/limit, etc.) and for /user/* profile operations. " +
        "Paths are relative to /api/v2 and MUST begin with 'system/' or 'user/'. Provide query as a flat object of " +
        "string values (do NOT embed '?' in path); provide body as a JSON object for POST/PATCH. Returns the DreamFactory " +
        "response, except that every `api_key` field at any depth is masked (null, plus an `api_key_hint` of \"…\" and the " +
        "last 4 characters), and secret fields (passwords, client secrets, tokens, license_key, private lookup values) " +
        "are replaced with \"**********\". Fields set to \"**********\" in `body` are dropped, so the stored secret stays " +
        "as it is. To mint a key the caller can actually see, use create_app.", {
        method: zod_1.z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).describe("HTTP verb."),
        path: zod_1.z
            .string()
            .describe("Path relative to /api/v2. MUST start with 'system/' or 'user/'. e.g. 'system/cors', 'system/email_template/3'."),
        body: zod_1.z.record(zod_1.z.unknown()).optional().describe("JSON body for POST/PATCH/PUT/DELETE-with-payload."),
        query: zod_1.z
            .record(zod_1.z.union([zod_1.z.string(), zod_1.z.number(), zod_1.z.boolean()]))
            .optional()
            .describe("Query string parameters as a flat object."),
    }, async ({ method, path, body, query }, extra) => {
        // Defense-in-depth: refuse paths that escape the control plane. The
        // guard validates the *resolved* URL (dot-segments, %2e, backslashes,
        // absolute URLs, embedded query) - see src/path-guard.ts.
        const guard = (0, path_guard_1.guardControlPlanePath)(path);
        if (!guard.ok || !guard.path) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            error: "path rejected: call_system_api is restricted to 'system/*' and 'user/*' endpoints " +
                                `(${guard.reason ?? "invalid path"}). Got: '${path}'.`,
                            status: 400,
                            operation: "call_system_api",
                        }, null, 2),
                    },
                ],
                isError: true,
            };
        }
        const auth = (0, dreamfactory_1.getAuthForSession)(extra.sessionId);
        const result = await (0, dreamfactory_1.dreamFactoryFetch)(method, guard.path, {
            auth,
            body,
            query,
        });
        // system/app (directly or nested via related=app_by_role_id etc.) carries
        // api_key; mask it at any depth so this hatch can't bypass list_apps/get_app.
        return (0, dreamfactory_1.toToolResponse)("call_system_api", (0, redact_1.maskResult)(result));
    });
}
//# sourceMappingURL=generic.js.map