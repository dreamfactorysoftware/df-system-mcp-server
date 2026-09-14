/**
 * Unit tests for API-key masking (src/redact.ts).
 * Run with: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiKeyHint,
  apiKeysExposed,
  isSecretEntryName,
  isSecretKey,
  maskApiKeys,
  maskResult,
  maskSecrets,
  SECRET_MASK,
  secretsExposed,
  stripMaskedSecrets,
  unwritableMaskPaths,
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
    "connection_string", "dsn", "key", "openai_api_key", "Authorization", "Proxy-Authorization", "Cookie",
    "Set-Cookie", "X-Api-Key", "auth",
  ];
  for (const k of secret) assert.equal(isSecretKey(k), true, k);
  const notSecret = [
    "api_key", "api_key_hint", "token_endpoint", "token_ttl", "session_token_ttl", "password_policy",
    "password_required", "secret_type", "oauth_client_id", "username", "host", "name", "keyboard", "monkey",
    "key_name", "primary_key", "license", "author", "auth_type", "Accept",
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

test("maskSecrets: header and parameter values are masked only for credential names", () => {
  const out = maskSecrets(
    {
      config: {
        base_url: "https://api.example.com",
        headers: [
          { id: 13, name: "Accept", value: "application/json", pass_from_client: false },
          { id: 14, name: "X-Custom-Header", value: "reports", pass_from_client: false },
          { id: 15, name: "Authorization", value: "Basic dXNlcjpwYXNzd29yZA==", pass_from_client: false },
          { id: 16, name: "X-Hub-Signature", value: "sha256=abc", pass_from_client: false },
        ],
        parameters: [
          { id: 9, name: "limit", value: "10", outbound: true },
          { id: 10, name: "sort", value: "", outbound: true },
          { id: 11, name: "api_key", value: "abc123", outbound: true },
          { id: 12, name: "page", value: 2 },
        ],
      },
    },
    {},
  );
  assert.deepEqual(out, {
    config: {
      base_url: "https://api.example.com",
      headers: [
        { id: 13, name: "Accept", value: "application/json", pass_from_client: false },
        { id: 14, name: "X-Custom-Header", value: "reports", pass_from_client: false },
        { id: 15, name: "Authorization", value: SECRET_MASK, pass_from_client: false },
        { id: 16, name: "X-Hub-Signature", value: SECRET_MASK, pass_from_client: false },
      ],
      parameters: [
        { id: 9, name: "limit", value: "10", outbound: true },
        { id: 10, name: "sort", value: "", outbound: true },
        { id: 11, name: "api_key", value: SECRET_MASK, outbound: true },
        { id: 12, name: "page", value: 2 },
      ],
    },
  });
});

test("maskSecrets: a credential-looking entry name masks its value anywhere; header maps by key name", () => {
  const out = maskSecrets(
    {
      resource: [
        { name: "X-API-KEY", value: "k" },
        { name: "session_cookie", value: "c" },
        { name: "Region", value: "us-east-1" },
      ],
      custom_headers: { Authorization: "Bearer abc", Accept: "text/plain" },
    },
    {},
  );
  assert.deepEqual(out, {
    resource: [
      { name: "X-API-KEY", value: SECRET_MASK },
      { name: "session_cookie", value: SECRET_MASK },
      { name: "Region", value: "us-east-1" },
    ],
    custom_headers: { Authorization: SECRET_MASK, Accept: "text/plain" },
  });
  for (const n of [
    "Authorization", "Proxy-Authorization", "Cookie", "Set-Cookie", "x-api-key", "access_token", "client-secret",
    "db_pass", "password", "X-Hub-Signature", "sig", "aws_sig_v4",
  ]) {
    assert.equal(isSecretEntryName(n), true, n);
  }
  for (const n of ["Accept", "Content-Type", "X-Custom-Header", "limit", "sort", "Region", "design", null, 5]) {
    assert.equal(isSecretEntryName(n), false, String(n));
  }
});

test("maskSecrets: curl options mask credential options and header lines; URL passwords are masked in place", () => {
  const out = maskSecrets(
    {
      config: {
        base_url: "https://svc:pw123@api.example.com/v1",
        options: {
          CURLOPT_PROXY: "http://proxyuser:proxypass@proxy.example.com:3128",
          PROXYUSERPWD: "proxyuser:proxypass",
          CURLOPT_TIMEOUT: 30,
          CURLOPT_SSL_VERIFYPEER: false,
          CURLOPT_USERAGENT: "df-rws",
          CURLOPT_HTTPHEADER: ["X-Trace: on", "Authorization: Bearer abc", "Cookie: sid=1"],
          "10005": "user:pw",
          "10023": ["Proxy-Authorization: Basic eDp5"],
        },
      },
      proxy_url: "http://proxy.example.com:3128",
    },
    {},
  );
  assert.deepEqual(out, {
    config: {
      base_url: `https://svc:${SECRET_MASK}@api.example.com/v1`,
      options: {
        CURLOPT_PROXY: `http://proxyuser:${SECRET_MASK}@proxy.example.com:3128`,
        PROXYUSERPWD: SECRET_MASK,
        CURLOPT_TIMEOUT: 30,
        CURLOPT_SSL_VERIFYPEER: false,
        CURLOPT_USERAGENT: "df-rws",
        CURLOPT_HTTPHEADER: ["X-Trace: on", `Authorization: ${SECRET_MASK}`, `Cookie: ${SECRET_MASK}`],
        "10005": SECRET_MASK,
        "10023": [`Proxy-Authorization: ${SECRET_MASK}`],
      },
    },
    proxy_url: "http://proxy.example.com:3128",
  });
});

test("unwritableMaskPaths: masks that can't be dropped to keep the stored secret", () => {
  assert.deepEqual(
    unwritableMaskPaths({
      config: {
        password: SECRET_MASK,
        headers: [
          { name: "Accept", value: "application/json" },
          { name: "Authorization", value: SECRET_MASK },
        ],
      },
    }),
    ["config.headers[1].value"],
  );
  assert.deepEqual(unwritableMaskPaths({ label: "x", password: SECRET_MASK, config: { password: SECRET_MASK } }), []);
  assert.deepEqual(unwritableMaskPaths({ resource: [{ config: { password: SECRET_MASK } }] }), [
    "resource[0].config.password",
  ]);
  assert.deepEqual(
    unwritableMaskPaths({
      config: {
        options: {
          PROXYUSERPWD: SECRET_MASK,
          CURLOPT_TIMEOUT: 30,
          CURLOPT_PROXY: `http://u:${SECRET_MASK}@proxy:3128`,
          CURLOPT_HTTPHEADER: [`Authorization: ${SECRET_MASK}`],
        },
      },
    }),
    ["config.options.PROXYUSERPWD", "config.options.CURLOPT_PROXY", "config.options.CURLOPT_HTTPHEADER[0]"],
  );
  assert.deepEqual(unwritableMaskPaths({ config: { base_url: `https://u:${SECRET_MASK}@api` } }), ["config.base_url"]);
  assert.deepEqual(unwritableMaskPaths({ nested: { config: { password: SECRET_MASK } } }), ["nested.config.password"]);
  assert.deepEqual(unwritableMaskPaths(null), []);
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
