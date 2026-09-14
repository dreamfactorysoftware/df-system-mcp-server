"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBaseUrl = getBaseUrl;
exports.setAuthForSession = setAuthForSession;
exports.clearAuthForSession = clearAuthForSession;
exports.getAuthForSession = getAuthForSession;
exports.countAuthSessions = countAuthSessions;
exports.dreamFactoryFetch = dreamFactoryFetch;
exports.toToolResponse = toToolResponse;
const redact_1 = require("./redact");
/**
 * Resolved DreamFactory base URL. Trimmed of any trailing slash. Defaults to
 * DreamFactory on the same host; the Docker image sets http://web/api/v2.
 */
function getBaseUrl() {
    const raw = process.env.DREAMFACTORY_URL || "http://127.0.0.1/api/v2";
    return raw.replace(/\/+$/, "");
}
/**
 * Per-MCP-session auth registry.
 *
 * The MCP SDK passes a `sessionId` to tool handlers (the StreamableHTTPServerTransport
 * generates one on `initialize`). We map that sessionId to the DreamFactory session
 * token we extracted from the corresponding HTTP request's headers in index.ts.
 *
 * NB: this is in-memory; restart drops sessions, which is fine — MCP clients re-init.
 */
const authBySession = new Map();
function setAuthForSession(sessionId, ctx) {
    authBySession.set(sessionId, ctx);
}
function clearAuthForSession(sessionId) {
    authBySession.delete(sessionId);
}
function getAuthForSession(sessionId) {
    if (!sessionId)
        return undefined;
    return authBySession.get(sessionId);
}
/** Number of sessions currently holding an auth context (for /health). */
function countAuthSessions() {
    return authBySession.size;
}
/**
 * Build a query string from an object, skipping undefined values.
 */
function buildQuery(query) {
    if (!query)
        return "";
    const parts = [];
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null)
            continue;
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    return parts.length ? `?${parts.join("&")}` : "";
}
/**
 * Centralised HTTP client for DreamFactory.
 *
 * - Injects X-DreamFactory-Session-Token from the supplied AuthContext.
 * - Forwards X-DreamFactory-API-Key / X-DreamFactory-Trace-Id when bound.
 * - Uses the per-session base URL (X-Mcp-Base-Url) when present, else DREAMFACTORY_URL.
 * - Sets Accept: application/json (and Content-Type when a body is present).
 * - Drops masked secrets ("**********") from the body so they never overwrite real ones, and
 *   refuses a body with a mask inside a list, which DreamFactory would store as the value.
 * - Never logs the session token.
 * - Returns a uniform { ok, status, data | error } envelope.
 */
async function dreamFactoryFetch(method, path, opts = {}) {
    const auth = opts.auth;
    if (!auth?.sessionToken) {
        return {
            ok: false,
            status: 401,
            error: "authentication required: no DreamFactory session token bound to this MCP session. " +
                "Send X-DreamFactory-Session-Token (or Authorization: Bearer ...) on the MCP HTTP request.",
        };
    }
    if (opts.body !== undefined && opts.body !== null) {
        const maskedInLists = (0, redact_1.maskedPathsInArrays)(opts.body);
        if (maskedInLists.length > 0) {
            const shown = maskedInLists.slice(0, 5).join(", ") + (maskedInLists.length > 5 ? ", ..." : "");
            return {
                ok: false,
                status: 400,
                error: `refusing to write masked secret(s) at ${shown}: DreamFactory replaces lists such as RWS headers and ` +
                    'parameters as a whole, so "**********" would be stored as the value. Send the real values, or leave ' +
                    "that list out of the request to keep the stored one.",
            };
        }
    }
    const base = (auth.baseUrl && auth.baseUrl.replace(/\/+$/, "")) || getBaseUrl();
    // Strip leading slash from path so caller can write "system/service" or "/system/service".
    const cleanPath = path.replace(/^\/+/, "");
    const url = `${base}/${cleanPath}${buildQuery(opts.query)}`;
    const headers = {
        Accept: "application/json",
        "X-DreamFactory-Session-Token": auth.sessionToken,
    };
    if (auth.apiKey)
        headers["X-DreamFactory-API-Key"] = auth.apiKey;
    if (auth.traceId)
        headers["X-DreamFactory-Trace-Id"] = auth.traceId;
    let bodyInit;
    if (opts.body !== undefined && opts.body !== null) {
        headers["Content-Type"] = "application/json";
        bodyInit = JSON.stringify((0, redact_1.stripMaskedSecrets)(opts.body));
    }
    try {
        const res = await fetch(url, { method, headers, body: bodyInit });
        const text = await res.text();
        let parsed = undefined;
        if (text.length > 0) {
            try {
                parsed = JSON.parse(text);
            }
            catch {
                parsed = text;
            }
        }
        if (!res.ok) {
            // DreamFactory error shape: { error: { code, message, context? } }
            let message = `HTTP ${res.status} ${res.statusText}`;
            if (parsed && typeof parsed === "object" && parsed !== null) {
                const errObj = parsed.error;
                if (errObj && typeof errObj === "object") {
                    const msg = errObj.message;
                    if (typeof msg === "string" && msg.length > 0)
                        message = msg;
                }
                else if (typeof parsed.message === "string") {
                    message = parsed.message;
                }
            }
            return { ok: false, status: res.status, error: message, details: parsed };
        }
        return { ok: true, status: res.status, data: parsed };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Never include headers or tokens in the error.
        return {
            ok: false,
            status: 0,
            error: `network error contacting DreamFactory at ${base}: ${message}`,
        };
    }
}
/**
 * Convert a DreamFactoryResult into the MCP tool text response shape.
 * Caller should pass a label that describes the operation for error context.
 * Every tool response passes through here, so secret masking (src/redact.ts)
 * is applied centrally; API-key masking stays with the tools that return apps.
 */
function toToolResponse(label, result) {
    if (result.ok) {
        return {
            content: [{ type: "text", text: JSON.stringify((0, redact_1.maskSecrets)(result.data), null, 2) }],
        };
    }
    const payload = {
        error: result.error,
        status: result.status,
        operation: label,
    };
    if (result.details !== undefined)
        payload.details = (0, redact_1.maskSecrets)(result.details);
    return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: true,
    };
}
//# sourceMappingURL=dreamfactory.js.map