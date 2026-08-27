/**
 * Smoke test: boot the HTTP server in-process, open an MCP client over the
 * Streamable HTTP transport, ask it to list tools, and assert all 17 of our
 * control-plane tools are exposed.
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

const PORT = 3791; // off the default to avoid local collisions

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

async function startServer(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", new URL("../src/index.ts", import.meta.url).pathname],
    {
      env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (b) => process.stdout.write(`[server] ${b}`));
  child.stderr?.on("data", (b) => process.stderr.write(`[server] ${b}`));
  await waitForHealth(`http://127.0.0.1:${PORT}/health`);
  return child;
}

test("MCP server exposes all 17 control-plane tools", async (t) => {
  const child = await startServer();
  t.after(() => {
    child.kill("SIGTERM");
  });

  // Confirm /health reports the expected count.
  const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
  assert.equal(health.status, "healthy");
  assert.equal(health.service, "df-system-mcp");
  assert.equal(health.tools, TOOL_NAMES.length);
  assert.equal(TOOL_NAMES.length, 17, "expected exactly 17 control-plane tools");

  // Connect MCP client over Streamable HTTP and list tools.
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${PORT}/mcp`),
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
