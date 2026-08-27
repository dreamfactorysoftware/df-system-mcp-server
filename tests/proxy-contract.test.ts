/**
 * Proxy-contract test: exercises the exact wire format the PHP
 * `DreamFactory\Core\McpServer\Client\McpDaemonClient` uses when it proxies a
 * `system_mcp` service to this daemon:
 *
 *   POST /mcp/{service}   body = { _mcpPayload, _mcpConfig, _mcpAvailableServices }
 *   headers: X-Mcp-Base-Url, X-DreamFactory-Session-Token, X-DreamFactory-API-Key,
 *            X-DreamFactory-Trace-Id, X-Mcp-Internal-Key, Mcp-Session-Id
 *
 * A mock DreamFactory records what it receives so we can assert header
 * forwarding and base-URL override.
 *
 * Run with: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { TOOL_NAMES } from "../src/tools";

const PORT = 3792; // off the default + off the smoke test port
const INTERNAL_KEY = "test";
const SESSION_TOKEN = "sess-token-abc";
const API_KEY = "api-key-xyz";
const TRACE_ID = "trace-123";

interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

function startMockDreamFactory(): Promise<{ server: Server; port: number; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const url = req.url ?? "";
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && url.startsWith("/api/v2/system/service")) {
        res.end(
          JSON.stringify({
            resource: [{ id: 1, name: "mysql-prod", type: "mysql", is_active: true }],
            meta: { count: 1 },
          }),
        );
      } else if (req.method === "POST" && url.startsWith("/api/v2/system/role")) {
        res.statusCode = 201;
        res.end(JSON.stringify({ resource: [{ id: 42, name: "FromMcp" }] }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: 404, message: `mock: no route for ${url}` } }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, seen });
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await delay(200);
  }
  throw new Error(`server failed to become healthy within ${timeoutMs}ms`);
}

async function startServer(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", new URL("../src/index.ts", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        MCP_INTERNAL_KEY: INTERNAL_KEY,
        // Deliberately wrong so we can prove X-Mcp-Base-Url wins.
        DREAMFACTORY_URL: "http://127.0.0.1:9/api/v2",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (b) => process.stdout.write(`[server] ${b}`));
  child.stderr?.on("data", (b) => process.stderr.write(`[server] ${b}`));
  await waitForHealth(`http://127.0.0.1:${PORT}/health`);
  return child;
}

/** Parse either a JSON body or an SSE stream (`event: message\ndata: {...}`) into JSON-RPC messages. */
function parseRpcResponse(text: string, contentType: string | null): unknown[] {
  if (contentType?.includes("text/event-stream")) {
    return text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()));
  }
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Send one PHP-style envelope exactly like McpDaemonClient::proxyRequest. */
async function proxyPost(
  baseUrl: string,
  payload: unknown,
  opts: {
    config?: Record<string, unknown>;
    sessionId?: string;
    internalKey?: string;
    extraHeaders?: Record<string, string>;
  } = {},
): Promise<{ status: number; sessionId: string | null; messages: unknown[] }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-mcp-base-url": baseUrl,
    "x-dreamfactory-session-token": SESSION_TOKEN,
    "x-dreamfactory-api-key": API_KEY,
    "x-dreamfactory-trace-id": TRACE_ID,
  };
  if (opts.internalKey !== undefined) headers["x-mcp-internal-key"] = opts.internalKey;
  if (opts.sessionId) headers["mcp-session-id"] = opts.sessionId;
  Object.assign(headers, opts.extraHeaders ?? {});
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp/sysmcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      _mcpPayload: payload,
      _mcpConfig: opts.config ?? {},
      _mcpAvailableServices: [],
    }),
  });
  const text = await res.text();
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    messages: parseRpcResponse(text, res.headers.get("content-type")),
  };
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "proxy-contract-test", version: "0.0.1" },
  },
};

function rpcResult(messages: unknown[], id: number): Record<string, unknown> {
  const msg = messages.find((m) => (m as { id?: unknown }).id === id) as
    | { result?: Record<string, unknown>; error?: unknown }
    | undefined;
  assert.ok(msg, `no JSON-RPC response with id=${id} in ${JSON.stringify(messages)}`);
  assert.equal(msg.error, undefined, `JSON-RPC error: ${JSON.stringify(msg.error)}`);
  return msg.result ?? {};
}

async function openSession(
  baseUrl: string,
  config: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const init = await proxyPost(baseUrl, initialize, { config, internalKey: INTERNAL_KEY, extraHeaders });
  assert.equal(init.status, 200, "initialize via envelope must succeed");
  const sid = init.sessionId;
  assert.ok(sid, "Mcp-Session-Id must be returned on initialize");
  const result = rpcResult(init.messages, 1);
  assert.equal((result.serverInfo as { name: string }).name, "df-system-mcp");

  const notified = await proxyPost(
    baseUrl,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { config, sessionId: sid, internalKey: INTERNAL_KEY, extraHeaders },
  );
  assert.equal(notified.status, 202, "notification must be accepted with 202");
  return sid;
}

async function listToolNames(baseUrl: string, sid: string, config: Record<string, unknown> = {}) {
  const listed = await proxyPost(
    baseUrl,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { config, sessionId: sid, internalKey: INTERNAL_KEY },
  );
  assert.equal(listed.status, 200);
  const tools = rpcResult(listed.messages, 2).tools as { name: string }[];
  return tools.map((t) => t.name).sort();
}

test("PHP proxy contract: envelope, header forwarding, internal key, disabled_tools", async (t) => {
  const mock = await startMockDreamFactory();
  const child = await startServer();
  t.after(() => {
    child.kill("SIGTERM");
    mock.server.close();
  });
  const baseUrl = `http://127.0.0.1:${mock.port}/api/v2`;

  await t.test("GET /ping mirrors /health with mode + active_sessions", async () => {
    const ping = await fetch(`http://127.0.0.1:${PORT}/ping`).then((r) => r.json());
    assert.equal(ping.status, "healthy");
    assert.equal(ping.mode, "stateful");
    assert.equal(typeof ping.active_sessions, "number");
    assert.equal(ping.tools, TOOL_NAMES.length);
  });

  await t.test("403 without internal key", async () => {
    const noKey = await proxyPost(baseUrl, initialize, {});
    assert.equal(noKey.status, 403);
    const err = (noKey.messages[0] as { error: { code: number; message: string } }).error;
    assert.equal(err.code, -32001);
    assert.equal(err.message, "Forbidden: invalid internal key");

    const wrongKey = await proxyPost(baseUrl, initialize, { internalKey: "nope" });
    assert.equal(wrongKey.status, 403);
  });

  await t.test("initialize -> initialized -> tools/list -> tools/call list_services", async () => {
    const sid = await openSession(baseUrl);

    const names = await listToolNames(baseUrl, sid);
    assert.deepEqual(names, [...TOOL_NAMES].sort(), "full catalogue when nothing disabled");

    const seenBefore = mock.seen.length;
    const called = await proxyPost(
      baseUrl,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_services", arguments: {} } },
      { sessionId: sid, internalKey: INTERNAL_KEY },
    );
    assert.equal(called.status, 200);
    const result = rpcResult(called.messages, 3);
    assert.notEqual(result.isError, true, `tool returned error: ${JSON.stringify(result)}`);
    const text = (result.content as { text: string }[])[0].text;
    assert.match(text, /mysql-prod/);

    // The mock DF must have seen exactly one call, with both DF headers + trace id,
    // on the overridden base URL (env DREAMFACTORY_URL points at a dead port).
    assert.equal(mock.seen.length, seenBefore + 1);
    const seen = mock.seen[mock.seen.length - 1];
    assert.equal(seen.method, "GET");
    assert.ok(seen.url.startsWith("/api/v2/system/service?"), `unexpected url ${seen.url}`);
    assert.equal(seen.headers["x-dreamfactory-session-token"], SESSION_TOKEN);
    assert.equal(seen.headers["x-dreamfactory-api-key"], API_KEY);
    assert.equal(seen.headers["x-dreamfactory-trace-id"], TRACE_ID);
    assert.equal(seen.headers["x-mcp-internal-key"], undefined, "internal key must not leak to DF");

    // Write path: create_role posts the { resource: [...] } shape.
    const role = await proxyPost(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "create_role", arguments: { name: "FromMcp" } },
      },
      { sessionId: sid, internalKey: INTERNAL_KEY },
    );
    const roleResult = rpcResult(role.messages, 4);
    assert.notEqual(roleResult.isError, true);
    const roleSeen = mock.seen[mock.seen.length - 1];
    assert.equal(roleSeen.method, "POST");
    assert.ok(roleSeen.url.startsWith("/api/v2/system/role"));
    assert.equal(JSON.parse(roleSeen.body).resource[0].name, "FromMcp");

    // DELETE /mcp/:service terminates the session.
    const del = await fetch(`http://127.0.0.1:${PORT}/mcp/sysmcp`, {
      method: "DELETE",
      headers: {
        "mcp-session-id": sid,
        "x-mcp-internal-key": INTERNAL_KEY,
        "x-mcp-config": JSON.stringify({}),
      },
    });
    assert.equal(del.status, 200);
    const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
    assert.equal(health.active_sessions, 0, "session must be evicted after DELETE");
  });

  await t.test("disabled_tools removes tools from tools/list", async () => {
    const config = { disabled_tools: ["delete_service", "not_a_real_tool"], custom_tools: [] };
    const sid = await openSession(baseUrl, config);
    const names = await listToolNames(baseUrl, sid, config);
    assert.ok(!names.includes("delete_service"), "delete_service must be hidden");
    assert.equal(names.length, TOOL_NAMES.length - 1);

    // Calling a disabled tool must fail (not registered).
    const called = await proxyPost(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "delete_service", arguments: { id_or_name: "x" } },
      },
      { config, sessionId: sid, internalKey: INTERNAL_KEY },
    );
    const msg = called.messages.find((m) => (m as { id?: unknown }).id === 5) as {
      error?: unknown;
      result?: { isError?: boolean };
    };
    assert.ok(msg.error !== undefined || msg.result?.isError === true, "disabled tool must not execute");
  });

  await t.test("call_system_api rejects data-plane paths, including dot-segment bypasses", async () => {
    const sid = await openSession(baseUrl);
    const bad = [
      "db/_table/x",
      "system/../db/_table/x",
      "/system/%2e%2e/db/_table/x",
      "system/..%2fdb/_table/x",
      "system\\..\\db\\_table\\x",
      "http://127.0.0.1:1/api/v2/system/service",
    ];
    let id = 100;
    for (const path of bad) {
      const seenBefore = mock.seen.length;
      const called = await proxyPost(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name: "call_system_api", arguments: { method: "GET", path } },
        },
        { sessionId: sid, internalKey: INTERNAL_KEY },
      );
      const result = rpcResult(called.messages, id);
      assert.equal(result.isError, true, `${path} must be rejected`);
      assert.match((result.content as { text: string }[])[0].text, /path rejected/);
      assert.equal(mock.seen.length, seenBefore, `${path}: rejected path must never reach DreamFactory`);
    }

    // And a legitimate escape-hatch call still goes through to system/*.
    const seenBefore = mock.seen.length;
    const ok = await proxyPost(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "call_system_api", arguments: { method: "GET", path: "/system/service", query: { limit: 1 } } },
      },
      { sessionId: sid, internalKey: INTERNAL_KEY },
    );
    const okResult = rpcResult(ok.messages, 7);
    assert.notEqual(okResult.isError, true, JSON.stringify(okResult));
    assert.equal(mock.seen.length, seenBefore + 1);
    assert.equal(mock.seen[mock.seen.length - 1].url, "/api/v2/system/service?limit=1");
  });

  await t.test("unknown / evicted Mcp-Session-Id returns 404 Session not found", async () => {
    const dead = "00000000-0000-4000-8000-000000000000";
    const post = await proxyPost(
      baseUrl,
      { jsonrpc: "2.0", id: 8, method: "tools/list", params: {} },
      { sessionId: dead, internalKey: INTERNAL_KEY },
    );
    assert.equal(post.status, 404);
    assert.equal((post.messages[0] as { error: { code: number } }).error.code, -32001);

    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`http://127.0.0.1:${PORT}/mcp/sysmcp`, {
        method,
        headers: { "mcp-session-id": dead, "x-mcp-internal-key": INTERNAL_KEY, accept: "text/event-stream" },
      });
      assert.equal(res.status, 404, `${method} with dead session id`);
      const body = (await res.json()) as { error: { code: number; message: string } };
      assert.equal(body.error.message, "Session not found");
    }

    // Genuinely missing header + non-initialize body stays a 400.
    const missing = await proxyPost(
      baseUrl,
      { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
      { internalKey: INTERNAL_KEY },
    );
    assert.equal(missing.status, 400);
  });

  await t.test("X-Mcp-Base-Url is bound at initialize and cannot be hijacked mid-session", async () => {
    const sid = await openSession(baseUrl);
    const seenBefore = mock.seen.length;
    // Same session id, attacker-controlled base URL (a dead port). The call
    // must still go to the mock bound at initialize.
    const called = await proxyPost("http://127.0.0.1:1/api/v2", {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "list_services", arguments: {} },
    }, { sessionId: sid, internalKey: INTERNAL_KEY });
    const result = rpcResult(called.messages, 10);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(mock.seen.length, seenBefore + 1, "call must reach the originally bound DreamFactory");
  });

  await t.test("X-Mcp-One-Shot: 1 closes the session after the first tool response", async () => {
    const before = ((await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json())) as { active_sessions: number })
      .active_sessions;
    const sid = await openSession(baseUrl, {}, { "x-mcp-one-shot": "1" });
    const mid = ((await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json())) as { active_sessions: number })
      .active_sessions;
    assert.equal(mid, before + 1, "handshake keeps the one-shot session alive");

    const listed = await proxyPost(
      baseUrl,
      { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} },
      { sessionId: sid, internalKey: INTERNAL_KEY },
    );
    assert.equal(listed.status, 200);
    assert.equal((rpcResult(listed.messages, 11).tools as unknown[]).length, TOOL_NAMES.length);

    await delay(100);
    const after = ((await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json())) as { active_sessions: number })
      .active_sessions;
    assert.equal(after, before, "one-shot session must be torn down after its first response");

    const again = await proxyPost(
      baseUrl,
      { jsonrpc: "2.0", id: 12, method: "tools/list", params: {} },
      { sessionId: sid, internalKey: INTERNAL_KEY },
    );
    assert.equal(again.status, 404, "torn-down session id is gone");
  });
});
