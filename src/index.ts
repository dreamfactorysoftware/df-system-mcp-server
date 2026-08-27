#!/usr/bin/env node
import express, { type Request, type Response } from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer, SERVER_NAME, SERVER_VERSION } from "./server";
import { TOOL_COUNT } from "./tools";
import {
  clearAuthForSession,
  getBaseUrl,
  setAuthForSession,
} from "./dreamfactory";

const PORT = parseInt(process.env.PORT || "3700", 10);
const HOST = process.env.HOST || "0.0.0.0";

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

/**
 * One transport per MCP session. The transport handles the JSON-RPC framing
 * over HTTP (POST for client->server, GET for server-streamed events).
 */
const transports = new Map<string, StreamableHTTPServerTransport>();

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
    ],
    exposedHeaders: ["Mcp-Session-Id", "mcp-session-id", "mcp-protocol-version"],
    credentials: false,
  }),
);
app.use(express.json({ limit: "10mb" }));

/** Health: cheap, dependency-free, used by Docker HEALTHCHECK. */
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "healthy",
    service: SERVER_NAME,
    version: SERVER_VERSION,
    tools: TOOL_COUNT,
    dreamfactory_url: getBaseUrl(),
  });
});

/**
 * POST /mcp — every MCP JSON-RPC message from the client lands here.
 *
 * Per the SDK pattern, we maintain one transport per session. The transport
 * generates the session id on the first `initialize` call and echoes it back
 * via the `Mcp-Session-Id` response header; subsequent calls include it on
 * the request. We use that id as our auth-context key.
 */
app.post("/mcp", async (req: Request, res: Response) => {
  const incomingSessionId = req.header("mcp-session-id");
  const token = extractSessionToken(req);

  try {
    let transport: StreamableHTTPServerTransport | undefined;

    if (incomingSessionId && transports.has(incomingSessionId)) {
      transport = transports.get(incomingSessionId)!;
      // Rebind auth in case the caller rotated tokens.
      if (token) setAuthForSession(incomingSessionId, { sessionToken: token });
    } else if (!incomingSessionId && isInitializeRequest(req.body)) {
      // Brand-new session: spin up a fresh transport + McpServer.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport!);
          if (token) setAuthForSession(sid, { sessionToken: token });
        },
        enableDnsRebindingProtection: false,
      });

      transport.onclose = () => {
        const sid = transport!.sessionId;
        if (sid) {
          transports.delete(sid);
          clearAuthForSession(sid);
        }
      };

      const mcpServer = buildMcpServer();
      await mcpServer.connect(transport);
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

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    // Don't leak tokens. Use a stringified, header-free error.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[df-system-mcp] POST /mcp failed:`, message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: `internal server error: ${message}` },
        id: null,
      });
    }
  }
});

/**
 * GET /mcp — server-to-client streaming channel (SSE) for asynchronous notifications.
 * DELETE /mcp — explicit session termination.
 * Both require a valid Mcp-Session-Id and delegate to the existing transport.
 */
const handleStreamOrTerminate = async (req: Request, res: Response) => {
  const sessionId = req.header("mcp-session-id");
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).send("invalid or missing Mcp-Session-Id header");
    return;
  }
  const transport = transports.get(sessionId)!;
  // Refresh bound token on every request — important for long-lived SSE streams
  // if the client rotates session.
  const token = extractSessionToken(req);
  if (token) setAuthForSession(sessionId, { sessionToken: token });
  await transport.handleRequest(req, res);
};
app.get("/mcp", handleStreamOrTerminate);
app.delete("/mcp", handleStreamOrTerminate);

// Last-resort error handler — never let stack traces leak (they might include
// internal paths). Keep terse.
process.on("unhandledRejection", (reason) => {
  console.error("[df-system-mcp] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[df-system-mcp] uncaughtException:", err);
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(
    `[df-system-mcp] listening on http://${HOST}:${PORT}  (tools=${TOOL_COUNT}, df=${getBaseUrl()})`,
  );
});

const shutdown = () => {
  console.log("[df-system-mcp] shutting down");
  for (const [sid, t] of transports.entries()) {
    try {
      t.close();
    } catch {
      /* noop */
    }
    transports.delete(sid);
    clearAuthForSession(sid);
  }
  httpServer.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
