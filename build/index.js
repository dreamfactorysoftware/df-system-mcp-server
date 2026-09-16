#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const crypto_1 = require("crypto");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const server_1 = require("./server");
const tools_1 = require("./tools");
const dreamfactory_1 = require("./dreamfactory");
const redact_1 = require("./redact");
const trust_1 = require("./trust");
/**
 * Listen address. The MCP_SYSTEM_DAEMON_* names win over generic PORT/HOST, which
 * may mean something else on a DreamFactory host. Loopback by default: the usual
 * deployment is a daemon next to DreamFactory; the Docker image sets HOST=0.0.0.0.
 */
const PORT = parseInt(process.env.MCP_SYSTEM_DAEMON_PORT || process.env.PORT || "3700", 10);
const HOST = process.env.MCP_SYSTEM_DAEMON_HOST || process.env.HOST || "127.0.0.1";
/**
 * On a loopback bind, local callers (DreamFactory's PHP proxy) may set
 * X-Mcp-Base-Url without the internal key, as with df-mcp-server's data daemon.
 * MCP_TRUST_LOOPBACK=false turns this off, e.g. behind a same-host reverse proxy.
 */
const TRUST_LOOPBACK = (0, trust_1.isLoopbackHost)(HOST) && !/^(0|false|no|off)$/i.test((process.env.MCP_TRUST_LOOPBACK ?? "").trim());
/** Shared secret; when set every /mcp* request must carry X-Mcp-Internal-Key. */
const INTERNAL_KEY = process.env.MCP_INTERNAL_KEY || "";
/** Idle-session eviction window (seconds). Default 30 minutes. */
const SESSION_TTL_SECONDS = Math.max(0, parseInt(process.env.SESSION_TTL_SECONDS || "1800", 10) || 0);
const SWEEP_INTERVAL_MS = 60_000;
/**
 * Origins that untrusted (non-internal-key) callers may name in X-Mcp-Base-Url.
 * Always includes the DREAMFACTORY_URL origin; extend with MCP_ALLOWED_BASE_URLS.
 */
const ALLOWED_BASE_ORIGINS = (0, trust_1.buildAllowedOrigins)((0, dreamfactory_1.getBaseUrl)(), process.env.MCP_ALLOWED_BASE_URLS);
/** Pull the DreamFactory session token from a request. */
function extractSessionToken(req) {
    const direct = req.header("x-dreamfactory-session-token");
    if (typeof direct === "string" && direct.length > 0)
        return direct;
    const bearer = req.header("authorization");
    if (typeof bearer === "string" && bearer.toLowerCase().startsWith("bearer ")) {
        return bearer.slice(7).trim() || undefined;
    }
    return undefined;
}
function nonEmpty(v) {
    return typeof v === "string" && v.length > 0 ? v : undefined;
}
/**
 * Build the per-session auth context from request headers. Every field is
 * optional: direct-mode clients (df-ai-assistant) send only the session token,
 * the PHP proxy (df-mcp-server McpDaemonClient) also sends base URL, API key
 * and trace id.
 */
function extractAuthContext(req) {
    const presented = nonEmpty(req.header("x-mcp-base-url"));
    const baseUrl = (0, trust_1.acceptBaseUrl)(presented, {
        internalKeyVerified: internalKeyVerified(req),
        loopbackCaller: TRUST_LOOPBACK && (0, trust_1.isLoopbackAddress)(req.socket.remoteAddress),
        allowedOrigins: ALLOWED_BASE_ORIGINS,
    });
    if (presented && !baseUrl) {
        console.warn("[df-system-mcp] ignoring X-Mcp-Base-Url from untrusted caller (set MCP_INTERNAL_KEY or MCP_ALLOWED_BASE_URLS, or listen on 127.0.0.1)");
    }
    return {
        sessionToken: extractSessionToken(req),
        apiKey: nonEmpty(req.header("x-dreamfactory-api-key")),
        baseUrl,
        traceId: nonEmpty(req.header("x-dreamfactory-trace-id")),
    };
}
/**
 * Merge a fresh context over an existing one, keeping old values for missing
 * headers. `baseUrl` is bound at initialize only and never overwritten — a
 * caller who merely knows a live Mcp-Session-Id must not be able to redirect
 * that session's DreamFactory traffic (token exfiltration).
 */
function mergeAuth(prev, next) {
    return {
        sessionToken: next.sessionToken ?? prev?.sessionToken,
        apiKey: next.apiKey ?? prev?.apiKey,
        baseUrl: prev?.baseUrl ?? next.baseUrl,
        traceId: next.traceId ?? prev?.traceId,
        secretFields: next.secretFields ?? prev?.secretFields,
    };
}
/** True when MCP_INTERNAL_KEY is configured and this request presented it (constant-time). */
function internalKeyVerified(req) {
    return INTERNAL_KEY.length > 0 && (0, trust_1.safeEqual)(req.header("x-mcp-internal-key"), INTERNAL_KEY);
}
/** `X-Mcp-One-Shot: 1` marks a session as single-use (closed after its first tool result). */
function isOneShot(req) {
    const v = (req.header("x-mcp-one-shot") ?? "").trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
}
/**
 * Unwrap the PHP proxy envelope on POST bodies:
 *   { "_mcpPayload": <json-rpc>, "_mcpConfig": <service config>, "_mcpAvailableServices": [...],
 *     "_mcpSecretFields": { <service type>: { secret: [...], maps: [...] } } }
 * `_mcpSecretFields` is optional (df-mcp-server sends it for system_mcp services).
 * Direct-mode clients send the bare JSON-RPC message, which passes through untouched.
 */
function unwrapEnvelope(body) {
    if (body && typeof body === "object" && !Array.isArray(body)) {
        const b = body;
        if (b._mcpPayload !== undefined) {
            const cfg = b._mcpConfig;
            return {
                payload: b._mcpPayload,
                config: cfg && typeof cfg === "object" ? cfg : undefined,
                secretFields: (0, redact_1.parseSecretFieldManifest)(b._mcpSecretFields),
            };
        }
    }
    return { payload: body, config: undefined, secretFields: undefined };
}
/** GET/DELETE carry the service config as a JSON string in X-Mcp-Config. */
function configFromHeader(req) {
    const raw = req.header("x-mcp-config");
    if (!raw)
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * One transport per MCP session. The transport handles the JSON-RPC framing
 * over HTTP (POST for client->server, GET for server-streamed events).
 */
const sessions = new Map();
function touchSession(sid, req, serviceName) {
    const entry = sessions.get(sid);
    if (!entry)
        return undefined;
    entry.lastSeen = Date.now();
    if (serviceName)
        entry.serviceName = serviceName;
    // Rebind auth in case the caller rotated tokens (baseUrl stays bound).
    entry.auth = mergeAuth(entry.auth, extractAuthContext(req));
    (0, dreamfactory_1.setAuthForSession)(sid, entry.auth);
    return entry;
}
function dropSession(sid, close) {
    const entry = sessions.get(sid);
    sessions.delete(sid);
    (0, dreamfactory_1.clearAuthForSession)(sid);
    if (entry && close) {
        try {
            void entry.transport.close();
        }
        catch {
            /* noop */
        }
    }
}
function sweepIdleSessions() {
    if (SESSION_TTL_SECONDS <= 0)
        return;
    const cutoff = Date.now() - SESSION_TTL_SECONDS * 1000;
    for (const [sid, entry] of sessions.entries()) {
        if (entry.lastSeen < cutoff) {
            console.log(`[df-system-mcp] evicting idle session (service=${entry.serviceName ?? "-"})`);
            dropSession(sid, true);
        }
    }
}
const app = (0, express_1.default)();
app.use((0, cors_1.default)({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: [
        "Content-Type",
        "Accept",
        "Mcp-Session-Id",
        "mcp-session-id",
        "Last-Event-ID",
        "mcp-protocol-version",
        "Authorization",
        "X-DreamFactory-Session-Token",
        "X-DreamFactory-API-Key",
        "X-DreamFactory-Trace-Id",
        "X-Mcp-Base-Url",
        "X-Mcp-Config",
        "X-Mcp-Internal-Key",
        "X-Mcp-One-Shot",
    ],
    exposedHeaders: ["Mcp-Session-Id", "mcp-session-id", "mcp-protocol-version"],
    credentials: false,
}));
app.use(express_1.default.json({ limit: "10mb" }));
/** Health: cheap, dependency-free, used by Docker HEALTHCHECK. */
const health = (_req, res) => {
    res.json({
        status: "healthy",
        service: server_1.SERVER_NAME,
        version: server_1.SERVER_VERSION,
        tools: tools_1.TOOL_COUNT,
        mode: "stateful",
        active_sessions: sessions.size,
        dreamfactory_url: (0, dreamfactory_1.getBaseUrl)(),
        listen: `${HOST}:${PORT}`,
        loopback_trust: TRUST_LOOPBACK,
    });
};
app.get("/health", health);
app.get("/ping", health);
/**
 * Internal-key gate (mirrors the data-plane daemon): when MCP_INTERNAL_KEY is
 * set, every /mcp* request must present the same value in X-Mcp-Internal-Key.
 */
const requireInternalKey = (req, res, next) => {
    if (!INTERNAL_KEY)
        return next();
    if (!internalKeyVerified(req)) {
        res.status(403).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Forbidden: invalid internal key" },
            id: null,
        });
        return;
    }
    next();
};
app.use(["/mcp", "/mcp/:serviceName"], requireInternalKey);
/**
 * POST /mcp and POST /mcp/:serviceName — every MCP JSON-RPC message lands here.
 *
 * Per the SDK pattern, we maintain one transport per session. The transport
 * generates the session id on the first `initialize` call and echoes it back
 * via the `Mcp-Session-Id` response header; subsequent calls include it on
 * the request. We use that id as our auth-context key.
 *
 * `:serviceName` is the DreamFactory service the PHP proxy routed through; it
 * is only used for logging.
 */
const handlePost = async (req, res) => {
    const incomingSessionId = req.header("mcp-session-id");
    const serviceName = nonEmpty(req.params.serviceName);
    const { payload, config, secretFields } = unwrapEnvelope(req.body);
    try {
        let transport;
        let entry;
        if (incomingSessionId) {
            entry = touchSession(incomingSessionId, req, serviceName);
            if (!entry) {
                // Unknown / evicted session: 404 per the Streamable HTTP spec (and the
                // SDK transport), so clients know to re-initialize.
                sendSessionNotFound(res);
                return;
            }
            if (secretFields) {
                entry.auth = { ...entry.auth, secretFields };
                (0, dreamfactory_1.setAuthForSession)(incomingSessionId, entry.auth);
            }
            transport = entry.transport;
        }
        else if ((0, types_js_1.isInitializeRequest)(payload)) {
            // Brand-new session: spin up a fresh transport + McpServer.
            const auth = { ...extractAuthContext(req), ...(secretFields ? { secretFields } : {}) };
            const oneShot = isOneShot(req);
            const t = new streamableHttp_js_1.StreamableHTTPServerTransport({
                sessionIdGenerator: () => (0, crypto_1.randomUUID)(),
                onsessioninitialized: (sid) => {
                    entry = { transport: t, auth, lastSeen: Date.now(), serviceName, oneShot };
                    sessions.set(sid, entry);
                    (0, dreamfactory_1.setAuthForSession)(sid, auth);
                },
                enableDnsRebindingProtection: false,
            });
            t.onclose = () => {
                const sid = t.sessionId;
                if (sid)
                    dropSession(sid, false);
            };
            const mcpServer = (0, server_1.buildMcpServer)(config);
            await mcpServer.connect(t);
            transport = t;
        }
        else {
            res.status(400).json({
                jsonrpc: "2.0",
                error: {
                    code: -32000,
                    message: "Bad Request: no Mcp-Session-Id header and body is not an initialize request.",
                },
                id: null,
            });
            return;
        }
        await transport.handleRequest(req, res, payload);
        // One-shot sessions (the PHP rpcStateless bridge never sends DELETE):
        // tear down as soon as the first real request has been answered.
        if (entry?.oneShot && transport.sessionId && isTerminalOneShotRequest(payload)) {
            res.once("finish", () => dropSession(transport.sessionId, true));
            if (res.writableFinished)
                dropSession(transport.sessionId, true);
        }
    }
    catch (err) {
        // Don't leak tokens. Use a stringified, header-free error.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[df-system-mcp] POST ${req.path} failed:`, message);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: { code: -32603, message: `internal server error: ${message}` },
                id: null,
            });
        }
    }
};
/**
 * GET /mcp[/:serviceName] — server-to-client streaming channel (SSE).
 * DELETE /mcp[/:serviceName] — explicit session termination.
 * Both require a valid Mcp-Session-Id and delegate to the existing transport.
 * The proxy sends the service config in X-Mcp-Config here; we only need to
 * parse it for validity — the tool set was fixed at initialize time.
 */
const handleStreamOrTerminate = async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    if (!sessionId) {
        res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" },
            id: null,
        });
        return;
    }
    void configFromHeader(req);
    const entry = touchSession(sessionId, req, nonEmpty(req.params.serviceName));
    if (!entry) {
        sendSessionNotFound(res);
        return;
    }
    await entry.transport.handleRequest(req, res);
};
/** 404 for an unknown/evicted Mcp-Session-Id — mirrors the SDK transport's own response. */
function sendSessionNotFound(res) {
    res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
    });
}
/**
 * A JSON-RPC *request* (has an id) that is not `initialize`. Notifications
 * (`notifications/initialized`) and the handshake itself keep a one-shot
 * session alive; the first tool/list/call ends it.
 */
function isTerminalOneShotRequest(payload) {
    const msgs = Array.isArray(payload) ? payload : [payload];
    return msgs.some((m) => {
        if (!m || typeof m !== "object")
            return false;
        const { id, method } = m;
        return id !== undefined && id !== null && method !== "initialize";
    });
}
app.post(["/mcp", "/mcp/:serviceName"], handlePost);
app.get(["/mcp", "/mcp/:serviceName"], handleStreamOrTerminate);
app.delete(["/mcp", "/mcp/:serviceName"], handleStreamOrTerminate);
// Last-resort error handler — never let stack traces leak (they might include
// internal paths). Keep terse.
process.on("unhandledRejection", (reason) => {
    console.error("[df-system-mcp] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("[df-system-mcp] uncaughtException:", err);
});
const sweeper = setInterval(sweepIdleSessions, SWEEP_INTERVAL_MS);
sweeper.unref();
const httpServer = app.listen(PORT, HOST, () => {
    console.log(`[df-system-mcp] listening on http://${HOST}:${PORT}  (tools=${tools_1.TOOL_COUNT}, df=${(0, dreamfactory_1.getBaseUrl)()}, ` +
        `internal_key=${INTERNAL_KEY ? "required" : "off"}, loopback_trust=${TRUST_LOOPBACK ? "on" : "off"}, ` +
        `session_ttl=${SESSION_TTL_SECONDS}s, ` +
        `allowed_base_origins=${[...ALLOWED_BASE_ORIGINS].join("|")})`);
});
const shutdown = () => {
    console.log("[df-system-mcp] shutting down");
    clearInterval(sweeper);
    for (const sid of [...sessions.keys()])
        dropSession(sid, true);
    httpServer.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
//# sourceMappingURL=index.js.map