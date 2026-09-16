"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeEqual = safeEqual;
exports.buildAllowedOrigins = buildAllowedOrigins;
exports.isLoopbackHost = isLoopbackHost;
exports.isLoopbackAddress = isLoopbackAddress;
exports.acceptBaseUrl = acceptBaseUrl;
/**
 * Trust boundary helpers for the HTTP front door.
 *
 * - `X-Mcp-Base-Url` tells the daemon where DreamFactory lives for a session.
 *   Because the daemon forwards the DreamFactory session token (and API key)
 *   to that URL, an untrusted caller must not be able to set it — otherwise
 *   anyone who can reach the daemon can exfiltrate tokens / SSRF. The header
 *   is honoured only when the request passed the internal-key gate, when the
 *   daemon listens on loopback and the caller is local (the daemon runs next to
 *   DreamFactory, so only processes on that host can reach it), or when its
 *   origin is on the allowlist (DREAMFACTORY_URL origin + MCP_ALLOWED_BASE_URLS).
 * - The internal-key comparison is constant-time.
 */
const crypto_1 = require("crypto");
/** Constant-time string comparison. Returns false for non-strings / length mismatch. */
function safeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string")
        return false;
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ab.length !== bb.length)
        return false;
    return (0, crypto_1.timingSafeEqual)(ab, bb);
}
function originOf(url) {
    if (!url)
        return undefined;
    try {
        return new URL(url).origin;
    }
    catch {
        return undefined;
    }
}
/**
 * Build the set of origins allowed in `X-Mcp-Base-Url` for callers that did
 * NOT pass the internal-key gate.
 *
 * @param defaultBaseUrl  the resolved DREAMFACTORY_URL (always allowed)
 * @param extra           comma-separated MCP_ALLOWED_BASE_URLS (origins or full URLs)
 */
function buildAllowedOrigins(defaultBaseUrl, extra) {
    const out = new Set();
    const d = originOf(defaultBaseUrl);
    if (d)
        out.add(d);
    for (const raw of (extra ?? "").split(",")) {
        const o = originOf(raw.trim());
        if (o)
            out.add(o);
    }
    return out;
}
/** True for a loopback listen address: 127.0.0.0/8, ::1 or localhost. */
function isLoopbackHost(host) {
    if (!host)
        return false;
    const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
    return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}
/** True for a loopback peer address, including IPv4-mapped IPv6 (`::ffff:127.0.0.1`). */
function isLoopbackAddress(addr) {
    if (!addr)
        return false;
    const a = addr.toLowerCase();
    return a === "::1" || /^(::ffff:)?127(\.\d{1,3}){3}$/.test(a);
}
/**
 * Decide whether a presented `X-Mcp-Base-Url` may be bound to a session.
 *
 * @param opts.internalKeyVerified  the request presented the correct internal key
 * @param opts.loopbackCaller       the daemon listens on loopback and this caller is local
 * @returns the URL to bind, or `undefined` when it must be ignored.
 */
function acceptBaseUrl(presented, opts) {
    if (!presented)
        return undefined;
    const origin = originOf(presented);
    if (!origin)
        return undefined; // unparsable -> never bind
    if (opts.internalKeyVerified || opts.loopbackCaller)
        return presented;
    return opts.allowedOrigins.has(origin) ? presented : undefined;
}
//# sourceMappingURL=trust.js.map