"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACCESS_USAGE_MIN_DF_SYSTEM = void 0;
exports.registerAuditTools = registerAuditTools;
const define_1 = require("./define");
const zod_1 = require("zod");
const dreamfactory_1 = require("../dreamfactory");
const redact_1 = require("../redact");
/**
 * Access-usage audit — wraps the read-only `GET system/access_usage` resource
 * (df-system 0.7.0+), which reports when each app (API key), role or user was
 * last used / last denied, plus derived cleanup flags. Older DreamFactory
 * versions answer 404 for that path.
 */
/** Minimum df-system release that serves system/access_usage. */
exports.ACCESS_USAGE_MIN_DF_SYSTEM = "0.7.0";
const LABEL = "get_access_audit";
/** A row counts as flagged when any cleanup signal is strictly true. */
function isFlagged(row) {
    if (!row || typeof row !== "object")
        return false;
    const r = row;
    return r.never_used === true || r.stale === true || r.disabled_but_attempted === true || r.role_unreferenced === true;
}
/** Keep only flagged rows; records the pre-filter count in meta. Unknown shapes pass through. */
function onlyFlaggedRows(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.resource))
        return data;
    const body = data;
    const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
    return {
        ...body,
        resource: body.resource.filter(isFlagged),
        meta: { ...meta, only_flagged: true, unfiltered_count: body.resource.length },
    };
}
/** Replace DreamFactory's generic 404/403 text with guidance the model can act on. */
function explainFailure(result) {
    if (result.status === 404) {
        return {
            ...result,
            error: `get_access_audit requires a DreamFactory version that provides system/access_usage ` +
                `(df-system ${exports.ACCESS_USAGE_MIN_DF_SYSTEM} or later); this instance returned 404 for that path ` +
                `(DreamFactory said: ${result.error}). Usage data is not available here: tell the user to upgrade, ` +
                `and do not infer that apps, roles or users are unused from configuration alone.`,
        };
    }
    if (result.status === 403) {
        return {
            ...result,
            error: `permission denied reading system/access_usage (DreamFactory said: ${result.error}). The session ` +
                `must belong to a DreamFactory admin, or to a role granted GET on the system service component ` +
                `'access_usage'.`,
        };
    }
    return result;
}
function registerAuditTools(server, opts) {
    (0, define_1.defineTool)(server, opts, LABEL, "READ-ONLY access-usage audit: when each app (API key), role or user last made an authorized request or was " +
        "last denied, with cleanup flags. Use it to find credentials and roles that look unused. " +
        "Each row: subject_type, subject_id, name (app name / role name / user email), is_active, last_used_at, " +
        "last_denied_at, last_service, last_status; last_service/last_status describe the last USE (any request not " +
        "rejected with 401/403), while a 401/403 only moves last_denied_at; " +
        "requests_30d and top_services (null when meta.ledger_available " +
        "is false, e.g. open-source installs); users also carry last_login_date and is_sys_admin. " +
        "Flags: never_used = no authorized request recorded; stale = last use older than stale_days; " +
        "disabled_but_attempted = inactive, yet clients still send it (recent denials: find that client before " +
        "removing anything); role_unreferenced (roles only, else null) = no app, user assignment, auth-provider " +
        "mapping or other config points at the role. " +
        "IMPORTANT: usage is only recorded from when tracking started, so never_used means 'no traffic recorded " +
        "since meta.tracking_started_at' (earliest recorded activity of any kind; null = nothing recorded yet). " +
        "If that date is recent (fresh install or upgrade), say so and treat never_used/stale as weak evidence. " +
        "Recommend DISABLING first (is_active=false: update_role for roles, call_system_api PATCH system/app/{id} or " +
        "system/user/{id} for apps and users), watching for breakage, and only then deleting; never delete " +
        "straight from this report. Never returns API keys.", {
        subject: zod_1.z
            .enum(["app", "role", "user"])
            .optional()
            .default("app")
            .describe('What to audit: "app" (API keys, default), "role", or "user".'),
        stale_days: zod_1.z
            .number()
            .int()
            .min(1)
            .optional()
            .default(90)
            .describe("A subject is `stale` when its last use is older than this many days. Default 90."),
        only_flagged: zod_1.z
            .boolean()
            .optional()
            .default(false)
            .describe("true = return only rows where never_used, stale, disabled_but_attempted or role_unreferenced is true " +
            "(meta.unfiltered_count keeps the total)."),
    }, async ({ subject, stale_days, only_flagged }, extra) => {
        const auth = (0, dreamfactory_1.getAuthForSession)(extra.sessionId);
        const result = await (0, dreamfactory_1.dreamFactoryFetch)("GET", "system/access_usage", {
            auth,
            // include_never_used is pinned so only_flagged can always see never-used rows.
            query: { subject, stale_days, include_never_used: true },
        });
        if (!result.ok)
            return (0, dreamfactory_1.toToolResponse)(LABEL, explainFailure(result));
        // The endpoint never returns api_key; mask anyway in case a future field does.
        const masked = (0, redact_1.maskResult)(result);
        if (only_flagged && masked.ok) {
            return (0, dreamfactory_1.toToolResponse)(LABEL, { ...masked, data: onlyFlaggedRows(masked.data) });
        }
        return (0, dreamfactory_1.toToolResponse)(LABEL, masked);
    });
}
//# sourceMappingURL=audit.js.map