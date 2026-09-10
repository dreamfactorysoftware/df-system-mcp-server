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
/** App keys the mock DreamFactory returns; must never reach the MCP client from read tools. */
const APP_KEY_A = "36fda24fe5588fa4285ac6c6c2fdfbdb6b6bc9834699774c9bf777f706d05a88";
const APP_KEY_B = "b1946ac92492d2347c6235b4d2611184d8e7a1c1c3f0e0b4a1e2f3c4d5e6f7a9";
const NEW_APP_KEY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** Mutable mock behaviour, so one mock can play both a new and an old DreamFactory. */
interface MockState {
  /** 200 serves the fixture; 404 = DF without system/access_usage; 403 = restricted admin. */
  accessUsageStatus: number;
}

function usageRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    subject_type: "app",
    is_active: true,
    last_used_at: "2026-09-10 16:08:12",
    last_denied_at: null,
    last_service: "db",
    last_status: 200,
    never_used: false,
    stale: false,
    disabled_but_attempted: false,
    role_unreferenced: null,
    last_login_date: null,
    is_sys_admin: null,
    requests_30d: 57,
    top_services: [{ service: "db", requests: 50 }],
    ...overrides,
  };
}

/** system/access_usage fixture, shaped per the df-system contract. */
function accessUsageFixture(url: string): unknown {
  const q = new URL(url, "http://mock").searchParams;
  const subject = q.get("subject") ?? "app";
  const resource =
    subject === "role"
      ? [
          usageRow({ subject_type: "role", subject_id: 2, name: "reports", role_unreferenced: false }),
          usageRow({
            subject_type: "role",
            subject_id: 9,
            name: "orphan",
            last_used_at: null,
            last_service: null,
            last_status: null,
            role_unreferenced: true,
            requests_30d: 0,
            top_services: [],
          }),
        ]
      : [
          usageRow({ subject_id: 4, name: "reporting_app" }),
          usageRow({ subject_id: 5, name: "never", last_used_at: null, never_used: true, requests_30d: 0 }),
          usageRow({ subject_id: 6, name: "old", last_used_at: "2026-01-02 03:04:05", stale: true, requests_30d: 0 }),
          usageRow({
            subject_id: 7,
            name: "revoked",
            is_active: false,
            last_denied_at: "2026-09-09 10:00:00",
            last_status: 403,
            disabled_but_attempted: true,
          }),
        ];
  return {
    resource,
    meta: {
      subject,
      stale_days: Number(q.get("stale_days") ?? 90),
      generated_at: "2026-09-10 16:30:00",
      tracking_started_at: "2026-08-01 09:15:00",
      ledger_available: true,
    },
  };
}

function startMockDreamFactory(): Promise<{ server: Server; port: number; seen: SeenRequest[]; state: MockState }> {
  const seen: SeenRequest[] = [];
  const state: MockState = { accessUsageStatus: 200 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const url = req.url ?? "";
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && url.startsWith("/api/v2/system/access_usage")) {
        if (state.accessUsageStatus === 200) {
          res.end(JSON.stringify(accessUsageFixture(url)));
        } else {
          res.statusCode = state.accessUsageStatus;
          const message =
            state.accessUsageStatus === 404
              ? "Resource 'access_usage' not found for service 'system'."
              : "Access Forbidden.";
          res.end(JSON.stringify({ error: { code: state.accessUsageStatus, message } }));
        }
      } else if (req.method === "GET" && url.startsWith("/api/v2/system/app/4")) {
        res.end(JSON.stringify({ id: 4, name: "reporting_app", role_id: 2, is_active: true, api_key: APP_KEY_A }));
      } else if (req.method === "GET" && url.startsWith("/api/v2/system/app")) {
        res.end(
          JSON.stringify({
            resource: [
              { id: 4, name: "reporting_app", role_id: 2, api_key: APP_KEY_A },
              { id: 5, name: "partner", role_id: 3, api_key: APP_KEY_B },
            ],
            meta: { count: 2 },
          }),
        );
      } else if (req.method === "POST" && url.startsWith("/api/v2/system/app")) {
        res.statusCode = 201;
        res.end(JSON.stringify({ resource: [{ id: 6, name: "NewApp", role_id: 2, api_key: NEW_APP_KEY }] }));
      } else if (req.method === "GET" && url.startsWith("/api/v2/system/role/2")) {
        res.end(
          JSON.stringify({
            id: 2,
            name: "reports",
            app_by_role_id: [{ id: 4, name: "reporting_app", api_key: APP_KEY_A }],
          }),
        );
      } else if (req.method === "GET" && url.startsWith("/api/v2/system/service")) {
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
      resolve({ server, port, seen, state });
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
        // Masking is the default under test; don't inherit an opt-out from the shell.
        MCP_EXPOSE_API_KEYS: "",
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

  await t.test("api_key is masked by list_apps, get_app and call_system_api; create_app returns it", async () => {
    const sid = await openSession(baseUrl);
    const call = async (id: number, name: string, args: Record<string, unknown>) => {
      const res = await proxyPost(
        baseUrl,
        { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
        { sessionId: sid, internalKey: INTERNAL_KEY },
      );
      const result = rpcResult(res.messages, id);
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
      return (result.content as { text: string }[])[0].text;
    };
    const noKeys = (text: string, label: string) => {
      assert.ok(!text.includes(APP_KEY_A), `${label} leaked APP_KEY_A`);
      assert.ok(!text.includes(APP_KEY_B), `${label} leaked APP_KEY_B`);
    };

    const listText = await call(20, "list_apps", {});
    noKeys(listText, "list_apps");
    const list = JSON.parse(listText) as { resource: Record<string, unknown>[]; meta: { count: number } };
    assert.equal(list.meta.count, 2);
    assert.deepEqual(
      list.resource.map((a) => [a.api_key, a.api_key_hint]),
      [
        [null, "…5a88"],
        [null, "…f7a9"],
      ],
    );

    const getText = await call(21, "get_app", { id: 4 });
    noKeys(getText, "get_app");
    const app = JSON.parse(getText) as Record<string, unknown>;
    assert.equal(app.name, "reporting_app");
    assert.equal(app.api_key, null);
    assert.equal(app.api_key_hint, "…5a88");

    const hatchText = await call(22, "call_system_api", {
      method: "GET",
      path: "system/role/2",
      query: { related: "app_by_role_id" },
    });
    noKeys(hatchText, "call_system_api related=app_by_role_id");
    assert.equal(JSON.parse(hatchText).app_by_role_id[0].api_key_hint, "…5a88");
    noKeys(await call(23, "call_system_api", { method: "GET", path: "system/app" }), "call_system_api system/app");

    const createText = await call(24, "create_app", { name: "NewApp", role_id: 2 });
    assert.equal(JSON.parse(createText).resource[0].api_key, NEW_APP_KEY, "create_app must return the real new key");
  });

  await t.test("get_access_audit: param passthrough, only_flagged, validation, 404/403", async () => {
    const sid = await openSession(baseUrl);
    let id = 300;
    const callRaw = async (args: Record<string, unknown>) => {
      const rid = ++id;
      const res = await proxyPost(
        baseUrl,
        { jsonrpc: "2.0", id: rid, method: "tools/call", params: { name: "get_access_audit", arguments: args } },
        { sessionId: sid, internalKey: INTERNAL_KEY },
      );
      return { rid, messages: res.messages };
    };
    const call = async (args: Record<string, unknown>) => {
      const { rid, messages } = await callRaw(args);
      const result = rpcResult(messages, rid);
      return { isError: result.isError === true, text: (result.content as { text: string }[])[0].text };
    };
    type Audit = { resource: { subject_id: number }[]; meta: Record<string, unknown> };

    // Defaults: subject=app, stale_days=90, include_never_used pinned true.
    const all = await call({});
    assert.equal(all.isError, false, all.text);
    assert.equal(
      mock.seen[mock.seen.length - 1].url,
      "/api/v2/system/access_usage?subject=app&stale_days=90&include_never_used=true",
    );
    assert.equal(mock.seen[mock.seen.length - 1].headers["x-dreamfactory-session-token"], SESSION_TOKEN);
    const allBody = JSON.parse(all.text) as Audit;
    assert.deepEqual(allBody.resource.map((r) => r.subject_id), [4, 5, 6, 7]);
    assert.equal(allBody.meta.ledger_available, true);
    assert.equal(allBody.meta.only_flagged, undefined, "meta untouched when not filtering");

    // only_flagged keeps never_used / stale / disabled_but_attempted rows.
    const flagged = await call({ only_flagged: true });
    const flaggedBody = JSON.parse(flagged.text) as Audit;
    assert.deepEqual(flaggedBody.resource.map((r) => r.subject_id), [5, 6, 7]);
    assert.equal(flaggedBody.meta.only_flagged, true);
    assert.equal(flaggedBody.meta.unfiltered_count, 4);
    assert.equal(flaggedBody.meta.generated_at, "2026-09-10 16:30:00", "DF meta preserved");
    assert.equal(flaggedBody.meta.tracking_started_at, "2026-08-01 09:15:00", "tracking_started_at preserved");

    // Roles: explicit params pass through; role_unreferenced=false is not a flag.
    const roles = await call({ subject: "role", stale_days: 30, only_flagged: true });
    assert.equal(
      mock.seen[mock.seen.length - 1].url,
      "/api/v2/system/access_usage?subject=role&stale_days=30&include_never_used=true",
    );
    assert.deepEqual((JSON.parse(roles.text) as Audit).resource.map((r) => r.subject_id), [9]);

    // Invalid args never reach DreamFactory.
    for (const bad of [{ stale_days: 0 }, { subject: "service" }]) {
      const seenBefore = mock.seen.length;
      const { rid, messages } = await callRaw(bad);
      const msg = messages.find((m) => (m as { id?: unknown }).id === rid) as {
        error?: unknown;
        result?: { isError?: boolean };
      };
      assert.ok(msg.error !== undefined || msg.result?.isError === true, `${JSON.stringify(bad)} must be rejected`);
      assert.equal(mock.seen.length, seenBefore, `${JSON.stringify(bad)} must not reach DreamFactory`);
    }

    try {
      mock.state.accessUsageStatus = 404;
      const old = await call({});
      assert.equal(old.isError, true);
      const oldErr = JSON.parse(old.text) as { error: string; status: number; operation: string };
      assert.equal(oldErr.status, 404);
      assert.equal(oldErr.operation, "get_access_audit");
      assert.match(oldErr.error, /requires a DreamFactory version that provides system\/access_usage/);
      assert.match(oldErr.error, /df-system 0\.7\.0/);

      mock.state.accessUsageStatus = 403;
      const denied = await call({ subject: "user" });
      assert.equal(denied.isError, true);
      const deniedErr = JSON.parse(denied.text) as { error: string; status: number };
      assert.equal(deniedErr.status, 403);
      assert.match(deniedErr.error, /permission denied/);
    } finally {
      mock.state.accessUsageStatus = 200;
    }
  });

  await t.test("disabled_tools can hide get_access_audit", async () => {
    const config = { disabled_tools: ["get_access_audit"] };
    const sid = await openSession(baseUrl, config);
    const names = await listToolNames(baseUrl, sid, config);
    assert.ok(!names.includes("get_access_audit"));
    assert.equal(names.length, TOOL_NAMES.length - 1);

    const seenBefore = mock.seen.length;
    const called = await proxyPost(
      baseUrl,
      { jsonrpc: "2.0", id: 400, method: "tools/call", params: { name: "get_access_audit", arguments: {} } },
      { config, sessionId: sid, internalKey: INTERNAL_KEY },
    );
    const msg = called.messages.find((m) => (m as { id?: unknown }).id === 400) as {
      error?: unknown;
      result?: { isError?: boolean };
    };
    assert.ok(msg.error !== undefined || msg.result?.isError === true, "disabled tool must not execute");
    assert.equal(mock.seen.length, seenBefore, "disabled tool must not reach DreamFactory");
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
