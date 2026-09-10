/**
 * Unit tests for API-key masking (src/redact.ts).
 * Run with: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { apiKeyHint, apiKeysExposed, maskApiKeys, maskResult } from "../src/redact";

const KEY = "36fda24fe5588fa4285ac6c6c2fdfbdb6b6bc9834699774c9bf777f706d05a88";
const OTHER = "0000000000000000000000000000000000000000000000000000000000001234";
const MASKED: NodeJS.ProcessEnv = {};

test("apiKeyHint: last 4 chars, bare prefix for short keys, null for missing", () => {
  assert.equal(apiKeyHint(KEY), "…5a88");
  assert.equal(apiKeyHint("short-key"), "…", "keys under 16 chars reveal nothing");
  assert.equal(apiKeyHint("abcd"), "…");
  assert.equal(apiKeyHint(""), null);
  assert.equal(apiKeyHint(null), null);
  assert.equal(apiKeyHint(undefined), null);
  assert.equal(apiKeyHint(12345), null);
});

test("maskApiKeys: single record", () => {
  const input = { id: 4, name: "reporting_app", api_key: KEY, role_id: 2 };
  const out = maskApiKeys(input, MASKED);
  assert.deepEqual(out, { id: 4, name: "reporting_app", api_key: null, role_id: 2, api_key_hint: "…5a88" });
  assert.equal(input.api_key, KEY, "input must not be mutated");
  assert.doesNotMatch(JSON.stringify(out), new RegExp(KEY));
});

test("maskApiKeys: { resource: [...] } wrapper and meta preserved", () => {
  const out = maskApiKeys(
    { resource: [{ id: 1, api_key: KEY }, { id: 2, api_key: OTHER }, { id: 3, api_key: null }], meta: { count: 3 } },
    MASKED,
  );
  assert.deepEqual(out, {
    resource: [
      { id: 1, api_key: null, api_key_hint: "…5a88" },
      { id: 2, api_key: null, api_key_hint: "…1234" },
      { id: 3, api_key: null, api_key_hint: null },
    ],
    meta: { count: 3 },
  });
});

test("maskApiKeys: nested related records and arrays at any depth", () => {
  const input = {
    resource: [
      {
        id: 7,
        name: "role",
        app_by_role_id: [{ id: 9, api_key: KEY, nested: { deeper: [{ api_key: OTHER }] } }],
      },
    ],
  };
  const text = JSON.stringify(maskApiKeys(input, MASKED));
  assert.doesNotMatch(text, new RegExp(KEY));
  assert.doesNotMatch(text, new RegExp(OTHER));
  const out = maskApiKeys(input, MASKED) as typeof input;
  const app = out.resource[0].app_by_role_id[0] as Record<string, unknown>;
  assert.equal(app.api_key, null);
  assert.equal(app.api_key_hint, "…5a88");
  assert.deepEqual((app.nested as { deeper: unknown[] }).deeper[0], { api_key: null, api_key_hint: "…1234" });
});

test("maskApiKeys: upstream api_key_hint cannot smuggle the key; scalars pass through", () => {
  assert.deepEqual(maskApiKeys({ api_key_hint: KEY, api_key: KEY }, MASKED), { api_key: null, api_key_hint: "…5a88" });
  assert.deepEqual(maskApiKeys({ api_key_hint: "kept" }, MASKED), { api_key_hint: "kept" }, "no api_key → untouched");
  assert.equal(maskApiKeys(null, MASKED), null);
  assert.equal(maskApiKeys("text", MASKED), "text");
  assert.deepEqual(maskApiKeys([1, "a", null], MASKED), [1, "a", null]);
});

test("MCP_EXPOSE_API_KEYS=true disables masking", () => {
  assert.equal(apiKeysExposed({}), false);
  assert.equal(apiKeysExposed({ MCP_EXPOSE_API_KEYS: "false" }), false);
  assert.equal(apiKeysExposed({ MCP_EXPOSE_API_KEYS: "TRUE" }), true);
  assert.equal(apiKeysExposed({ MCP_EXPOSE_API_KEYS: "1" }), true);
  const input = { resource: [{ id: 1, api_key: KEY }] };
  assert.equal(maskApiKeys(input, { MCP_EXPOSE_API_KEYS: "true" }), input);
});

test("maskResult: masks data on success and details on error", () => {
  const ok = maskResult({ ok: true, status: 200, data: { api_key: KEY } }, MASKED);
  assert.ok(ok.ok);
  assert.deepEqual(ok.data, { api_key: null, api_key_hint: "…5a88" });

  const err = maskResult({ ok: false, status: 400, error: "bad", details: { resource: [{ api_key: KEY }] } }, MASKED);
  assert.ok(!err.ok);
  assert.doesNotMatch(JSON.stringify(err), new RegExp(KEY));

  const exposed = maskResult({ ok: true, status: 200, data: { api_key: KEY } }, { MCP_EXPOSE_API_KEYS: "true" });
  assert.ok(exposed.ok);
  assert.deepEqual(exposed.data, { api_key: KEY });
});
