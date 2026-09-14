/**
 * Unit tests for API-key masking (src/redact.ts).
 * Run with: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiKeyHint,
  apiKeysExposed,
  isSecretKey,
  maskApiKeys,
  maskResult,
  maskSecrets,
  SECRET_MASK,
  secretsExposed,
  stripMaskedSecrets,
} from "../src/redact";

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

const LICENSE = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

test("isSecretKey: secret-looking names, including camelCase", () => {
  const secret = [
    "password", "PASSWORD", "db_password", "passphrase", "private_key_passphrase", "secret", "client_secret",
    "oauth_client_secret", "clientSecret", "aws_secret_access_key", "private_key", "privateKey", "license_key",
    "app_key", "encryption_key", "token", "access_token", "refresh_token", "session_token", "credentials",
    "connection_string", "dsn", "key", "openai_api_key",
  ];
  for (const k of secret) assert.equal(isSecretKey(k), true, k);
  const notSecret = [
    "api_key", "api_key_hint", "token_endpoint", "token_ttl", "session_token_ttl", "password_policy",
    "password_required", "secret_type", "oauth_client_id", "username", "host", "name", "keyboard", "monkey",
    "key_name", "primary_key", "license",
  ];
  for (const k of notSecret) assert.equal(isSecretKey(k), false, k);
});

test("maskSecrets: environment license_key, service config credentials, nested and in arrays", () => {
  const input = {
    platform: { version: "7.7.0", license: "GOLD", license_key: LICENSE },
    resource: [
      {
        id: 7,
        name: "mail",
        config: {
          host: "smtp.example.com",
          port: 587,
          username: "mailer",
          password: "hunter2hunter2",
          oauth_client_secret: "s".repeat(64),
          credentials: { client_email: "x@example.com", private_key: "pk" },
          token_endpoint: "https://login.example.com/oauth2/token",
          password_required: true,
          secret: null,
          token: "",
        },
      },
    ],
  };
  const out = maskSecrets(input, {});
  assert.deepEqual(out, {
    platform: { version: "7.7.0", license: "GOLD", license_key: SECRET_MASK },
    resource: [
      {
        id: 7,
        name: "mail",
        config: {
          host: "smtp.example.com",
          port: 587,
          username: "mailer",
          password: SECRET_MASK,
          oauth_client_secret: SECRET_MASK,
          credentials: SECRET_MASK,
          token_endpoint: "https://login.example.com/oauth2/token",
          password_required: true,
          secret: null,
          token: "",
        },
      },
    ],
  });
  assert.equal(input.platform.license_key, LICENSE, "input must not be mutated");
});

test("maskSecrets: private lookup values, api_key left to maskApiKeys", () => {
  const out = maskSecrets(
    {
      resource: [
        { name: "db_pass", value: "p@ss", private: true },
        { name: "region", value: "us-east-1", private: false },
      ],
      app: { api_key: KEY },
    },
    {},
  );
  assert.deepEqual(out, {
    resource: [
      { name: "db_pass", value: SECRET_MASK, private: true },
      { name: "region", value: "us-east-1", private: false },
    ],
    app: { api_key: KEY },
  });
});

test("MCP_EXPOSE_SECRETS=true disables secret masking", () => {
  assert.equal(secretsExposed({}), false);
  assert.equal(secretsExposed({ MCP_EXPOSE_SECRETS: "yes" }), true);
  const input = { password: "x" };
  assert.equal(maskSecrets(input, { MCP_EXPOSE_SECRETS: "true" }), input);
});

test("stripMaskedSecrets: drops masked values at any depth, keeps everything else", () => {
  const body = {
    label: "Mail",
    config: { host: "smtp2.example.com", password: SECRET_MASK, nested: [{ secret: SECRET_MASK, keep: 1 }] },
    list: [SECRET_MASK, "a"],
  };
  assert.deepEqual(stripMaskedSecrets(body), {
    label: "Mail",
    config: { host: "smtp2.example.com", nested: [{ keep: 1 }] },
    list: [SECRET_MASK, "a"],
  });
  assert.equal(body.config.password, SECRET_MASK, "input must not be mutated");
  assert.equal(stripMaskedSecrets(null), null);
  assert.equal(stripMaskedSecrets("text"), "text");
});
