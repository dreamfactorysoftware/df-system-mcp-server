#!/usr/bin/env node
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer, SERVER_NAME, SERVER_VERSION } from "./server";
import { TOOL_COUNT } from "./tools";
import { clearAuthForSession, getBaseUrl, setAuthForSession } from "./dreamfactory";
import type { AuthContext, McpServiceConfig } from "./types";

const PORT = parseInt(process.env.PORT || "3700", 10);
const HOST = process.env.HOST || "0.0.0.0";
/** Shared secret; when set every /mcp* request must carry X-Mcp-Internal-Key. */
const INTERNAL_KEY = process.env.MCP_INTERNAL_KEY || "";
/** Idle-session eviction window (seconds). Default 30 minutes. */
const SESSION_TTL_SECONDS = Math.max(
  0,
  parseInt(process.env.SESSION_TTL_SECONDS || "1800", 10) || 0,
);
const SWEEP_INTERVAL_MS = 60_000;

/** Pull the DreamFactory session token from a request. */
function extractSessionToken(req: Request): string | undefined {
  const direct = req.header("x-dreamfactory-session-token");
  if (typeof direct === "string" && direct.length > 0) return direct;
  const bearer = req.header("authorization");
  if (typeof bearer === "string" && bearer.toLowerCase().startsWith("bearer ")) {
    return bearer.slice(7).trim() || undefined;
  }
  return undefined;
}

function nonEmpty(v: string | undefined): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Build the per-session auth context from request headers. Every field is
 * optional: direct-mode clients (df-ai-assistant) send only the session token,
 * the PHP proxy (df-mcp-server McpDaemonClient) also sends base URL, API key
 * and trace id.
 */
function extractAuthContext(req: Request): AuthContext {
  return {
    sessionToken: extractSessionToken(req),
    apiKey: nonEmpty(req.header("x-dreamfactory-api-key")),
    baseUrl: nonEmpty(req.header("x-mcp-base-url")),
    traceId: nonEmpty(req.header("x-dreamfactory-trace-id")),
  };
}

/** Merge a fresh context over an existing one, keeping old values for missing headers. */
function mergeAuth(prev: AuthContext | undefined, next: AuthContext): AuthContext {
  return {
    sessionToken: next.sessionToken ?? prev?.sessionToken,
    apiKey: next.apiKey ?? prev?.apiKey,
    baseUrl: next.baseUrl ?? prev?.baseUrl,
    traceId: next.traceId ?? prev?.traceId,
  };
}

/**
 * Unwrap the PHP proxy envelope on POST bodies:
 *   { "_mcpPayload": <json-rpc>, "_mcpConfig": <service config>, "_mcpAvailableServices": [...] }
 * Direct-mode clients send the bare JSON-RPC message, which passes through untouched.
 */
function unwrapEnvelope(body: unknown): { payload: unknown; config: McpServiceConfig | undefined } {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (b._mcpPayload !== undefined) {
      const cfg = b._mcpConfig;
      return {
        payload: b._mcpPayload,
        config: cfg && typeof cfg === "object" ? (cfg as McpServiceConfig) : undefined,
      };
    }
  }
  return { payload: body, config: undefined };
}

/** GET/DELETE carry the service config as a JSON string in X-Mcp-Config. */
function configFromHeader(req: Request): McpServiceConfig | undefined {
  const raw = req.header("x-mcp-config");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as McpServiceConfig) : undefined;
  } catch {
    return undefined;
  }
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  auth: AuthContext;
  lastSeen: number;
  serviceName?: string;
}

/**
 * One transport per MCP session. The transport handles the JSON-RPC framing
 * over HTTP (POST for client->server, GET for server-streamed events).
 */
const sessions = new Map<string, SessionEntry>();

function touchSession(sid: string, req: Request, serviceName?: string): SessionEntry | undefined {
  const entry = sessions.get(sid);
  if (!entry) return undefined;
  entry.lastSeen = Date.now();
  if (serviceName) entry.serviceName = serviceName;
  // Rebind auth in case the caller rotated tokens / base URL.
  entry.auth = mergeAuth(entry.auth, extractAuthContext(req));
  setAuthForSession(sid, entry.auth);
  return entry;
}

function dropSession(sid: string, close: boolean): void {
  const entry = sessions.get(sid);
  sessions.delete(sid);
  clearAuthForSession(sid);
  if (entry && close) {
    try {
      void entry.transport.close();
    } catch {
      /* noop */
    }
  }
}

function sweepIdleSessions(): void {
  if (SESSION_TTL_SECONDS <= 0) return;
  const cutoff = Date.now() - SESSION_TTL_SECONDS * 1000;
  for (const [sid, entry] of sessions.entries()) {
    if (entry.lastSeen < cutoff) {
      console.log(`[df-system-mcp] evicting idle session (service=${entry.serviceName ?? "-"})`);
      dropSession(sid, true);
    }
  }
}

const app = express();

app.use(
  cors({
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
    ],
    exposedHeaders: ["Mcp-Session-Id", "mcp-session-id", "mcp-protocol-version"],
    credentials: false,
  }),
);
app.use(express.json({ limit: "10mb" }));

/** Health: cheap, dependency-free, used by Docker HEALTHCHECK. */
const health = (_req: Request, res: Response) => {
  res.json({
    status: "healthy",
    service: SERVER_NAME,
    version: SERVER_VERSION,
    tools: TOOL_COUNT,
    mode: "stateful",
    active_sessions: sessions.size,
    dreamfactory_url: getBaseUrl(),
  });
};
app.get("/health", health);
app.get("/ping", health);

/**
 * Internal-key gate (mirrors the data-plane daemon): when MCP_INTERNAL_KEY is
 * set, every /mcp* request must present the same value in X-Mcp-Internal-Key.
 */
const requireInternalKey = (req: Request, res: Response, next: NextFunction) => {
  if (!INTERNAL_KEY) return next();
  const presented = req.header("x-mcp-internal-key");
  if (presented !== INTERNAL_KEY) {
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
const handlePost = async (req: Request, res: Response) => {
  const incomingSessionId = req.header("mcp-session-id");
  const serviceName = nonEmpty(req.params.serviceName);
  const { payload, config } = unwrapEnvelope(req.body);

  try {
    let transport: StreamableHTTPServerTransport | undefined;

    if (incomingSessionId && sessions.has(incomingSessionId)) {
      transport = touchSession(incomingSessionId, req, serviceName)!.transport;
    } else if (!incomingSessionId && isInitializeRequest(payload)) {
      // Brand-new session: spin up a fresh transport + McpServer.
      const auth = extractAuthContext(req);
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport: t, auth, lastSeen: Date.now(), serviceName });
          setAuthForSession(sid, auth);
        },
        enableDnsRebindingProtection: false,
      });

      t.onclose = () => {
        const sid = t.sessionId;
        if (sid) dropSession(sid, false);
      };

      const mcpServer = buildMcpServer(config);
      await mcpServer.connect(t);
      transport = t;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "Bad Request: no Mcp-Session-Id header and body is not an initialize request.",
        },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, payload);
  } catch (err) {
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
const handleStreamOrTerminate = async (req: Request, res: Response) => {
  const sessionId = req.header("mcp-session-id");
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).send("invalid or missing Mcp-Session-Id header");
    return;
  }
  void configFromHeader(req);
  const entry = touchSession(sessionId, req, nonEmpty(req.params.serviceName))!;
  await entry.transport.handleRequest(req, res);
};

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
  console.log(
    `[df-system-mcp] listening on http://${HOST}:${PORT}  (tools=${TOOL_COUNT}, df=${getBaseUrl()}, ` +
      `internal_key=${INTERNAL_KEY ? "required" : "off"}, session_ttl=${SESSION_TTL_SECONDS}s)`,
  );
});

const shutdown = () => {
  console.log("[df-system-mcp] shutting down");
  clearInterval(sweeper);
  for (const sid of [...sessions.keys()]) dropSession(sid, true);
  httpServer.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
