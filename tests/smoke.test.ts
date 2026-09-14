/**
 * Smoke test: boot the HTTP server in-process, open an MCP client over the
 * Streamable HTTP transport, ask it to list tools, and assert all 18 of our
 * control-plane tools are exposed. Also covers which callers may set
 * X-Mcp-Base-Url without MCP_INTERNAL_KEY.
 *
 * Run with: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOOL_NAMES } from "../src/tools";

// Off the default to avoid local collisions. One port per server, so a server
// still shutting down from an earlier test can't answer the next health check.
const PORTS = { smoke: 3791, networkBind: 3793, loopbackBind: 3794, loopbackTrustOff: 3795 };
// Both are dead ports: a tool call fails fast with a message naming the base URL it used.
const DEFAULT_DF = "http://127.0.0.1:2/api/v2";
const PRESENTED_DF = "http://127.0.0.1:1/api/v2";

function waitForHealth(url: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  return (async () => {
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
  })();
}

async function startServer(port: number, env: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", new URL("../src/index.ts", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        MCP_SYSTEM_DAEMON_PORT: String(port),
        MCP_SYSTEM_DAEMON_HOST: "127.0.0.1",
        MCP_INTERNAL_KEY: "",
        MCP_TRUST_LOOPBACK: "",
        DREAMFACTORY_URL: DEFAULT_DF,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (b) => process.stdout.write(`[server] ${b}`));
  child.stderr?.on("data", (b) => process.stderr.write(`[server] ${b}`));
  await waitForHealth(`http://127.0.0.1:${port}/health`);
  return child;
}

/**
 * Open a session that presents PRESENTED_DF in X-Mcp-Base-Url, call list_services,
 * and return the tool's error text (both base URLs are dead, so the call must fail).
 */
async function listServicesError(port: number): Promise<string> {
  const url = `http://127.0.0.1:${port}/mcp`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-dreamfactory-session-token": "sess-abc",
    "x-mcp-base-url": PRESENTED_DF,
  };
  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
  assert.equal(init.status, 200);
  const sid = init.headers.get("mcp-session-id");
  assert.ok(sid);
  await init.text();
  headers["mcp-session-id"] = sid;
  await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).then((r) => r.text());

  const call = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_services", arguments: {} },
    }),
  });
  const text = await call.text();
  const msg = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5).trim()))
    .concat(text.trim().startsWith("{") ? [JSON.parse(text)] : [])
    .find((m) => m.id === 2) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.ok(msg, `no response: ${text}`);
  assert.equal(msg.result.isError, true, "call must fail (both base URLs are dead ports)");
  return msg.result.content[0].text;
}

const usedDefault = /127\.0\.0\.1:2\/api\/v2/;
const usedPresented = /127\.0\.0\.1:1\//;

test("MCP server exposes all 18 control-plane tools", async (t) => {
  const child = await startServer(PORTS.smoke);
  t.after(() => {
    child.kill("SIGTERM");
  });

  // Confirm /health reports the expected count and the daemon defaults.
  const health = await fetch(`http://127.0.0.1:${PORTS.smoke}/health`).then((r) => r.json());
  assert.equal(health.status, "healthy");
  assert.equal(health.service, "df-system-mcp");
  assert.equal(health.tools, TOOL_NAMES.length);
  assert.equal(health.version, "0.4.1");
  assert.equal(health.listen, `127.0.0.1:${PORTS.smoke}`);
  assert.equal(health.loopback_trust, true);
  assert.equal(TOOL_NAMES.length, 18, "expected exactly 18 control-plane tools");

  // Connect MCP client over Streamable HTTP and list tools.
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${PORTS.smoke}/mcp`),
  );
  const client = new Client({ name: "smoke-test", version: "0.0.1" });
  await client.connect(transport);

  try {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    const expected = [...TOOL_NAMES].sort();
    assert.deepEqual(names, expected, "tool catalogue must match TOOL_NAMES");

    // Every tool must carry a non-trivial description (so qwen2.5:7b can route).
    for (const tool of listed.tools) {
      assert.ok(
        tool.description && tool.description.length > 40,
        `tool ${tool.name} has too short a description for small-LLM routing`,
      );
    }
  } finally {
    await client.close();
  }
});

test("network bind: untrusted X-Mcp-Base-Url is ignored (no MCP_INTERNAL_KEY)", async (t) => {
  const child = await startServer(PORTS.networkBind, { MCP_SYSTEM_DAEMON_HOST: "0.0.0.0" });
  t.after(() => {
    child.kill("SIGTERM");
  });

  const errText = await listServicesError(PORTS.networkBind);
  assert.match(errText, usedDefault, `must use DREAMFACTORY_URL, got: ${errText}`);
  assert.doesNotMatch(errText, usedPresented, "presented base URL must never be contacted");
});

test("loopback bind: local callers may set X-Mcp-Base-Url (daemon next to DreamFactory)", async (t) => {
  const child = await startServer(PORTS.loopbackBind);
  t.after(() => {
    child.kill("SIGTERM");
  });

  const errText = await listServicesError(PORTS.loopbackBind);
  assert.match(errText, usedPresented, `must use the presented base URL, got: ${errText}`);
  assert.doesNotMatch(errText, usedDefault);
});

test("loopback bind with MCP_TRUST_LOOPBACK=false: X-Mcp-Base-Url is ignored", async (t) => {
  const child = await startServer(PORTS.loopbackTrustOff, { MCP_TRUST_LOOPBACK: "false" });
  t.after(() => {
    child.kill("SIGTERM");
  });

  const health = await fetch(`http://127.0.0.1:${PORTS.loopbackTrustOff}/health`).then((r) => r.json());
  assert.equal(health.loopback_trust, false);
  const errText = await listServicesError(PORTS.loopbackTrustOff);
  assert.match(errText, usedDefault, `must use DREAMFACTORY_URL, got: ${errText}`);
  assert.doesNotMatch(errText, usedPresented, "presented base URL must never be contacted");
});
