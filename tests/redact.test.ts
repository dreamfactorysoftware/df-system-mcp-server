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
  parseSecretFieldManifest,
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
    "connection_string", "dsn", "openai_api_key", "Authorization", "Proxy-Authorization", "Cookie",
    "Set-Cookie", "X-Api-Key", "auth", "api_key", "api_keys", "data_chat_api_keys", "passcode", "tokens",
    "apikey", "apiKey", "access_key", "storage_access_key",
  ];
  for (const k of secret) assert.equal(isSecretKey(k), true, k);
  const notSecret = [
    "key", "access_key_id", "sort_key", "api_key_hint", "token_endpoint", "token_ttl", "session_token_ttl", "password_policy",
    "password_required", "secret_type", "oauth_client_id", "username", "host", "name", "keyboard", "monkey",
    "key_name", "primary_key", "license", "author", "auth_type", "Accept",
  ];
  for (const k of notSecret) assert.equal(isSecretKey(k), false, k);
});

test("maskSecrets: key/value descriptors keep their shape; a bare key is not a secret name", () => {
  // As in DreamFactory's rws / mysql config_schema: `key` describes the key half of each pair.
  const options = {
    name: "options",
    type: "object",
    object: { key: { label: "Name", type: "string" }, value: { label: "Value", type: "string" } },
  };
  assert.deepEqual(maskSecrets({ config_schema: [options] }, {}), { config_schema: [options] });
  assert.deepEqual(maskSecrets({ key: "AKIAEXAMPLE", secret: "s3cr3t" }, {}), { key: "AKIAEXAMPLE", secret: SECRET_MASK });
});

test("maskSecrets: type descriptors keep their type names; real values beside them are still masked", () => {
  // DreamFactory's system/environment login APIs (df-system Environment::getLoginApi).
  const authentication = {
    admin: { path: "system/admin/session", verb: "POST", payload: { email: "string", password: "string", remember_me: "bool" } },
    ldap: {
      path: "user/session?service=ldap",
      verb: "POST",
      payload: { username: "string", password: "string", service: "ldap", remember_me: "bool" },
    },
  };
  assert.deepEqual(maskSecrets({ authentication }, {}), { authentication });
  assert.deepEqual(maskSecrets({ username: "string", password: "hunter2", remember_me: "bool" }, {}), {
    username: "string",
    password: SECRET_MASK,
    remember_me: "bool",
  });
  assert.deepEqual(maskSecrets({ host: "db", password: "string" }, {}), { host: "db", password: SECRET_MASK }, "one type name is not a descriptor");
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

test("maskSecrets: private lookup values; api_key masked unless keepApiKeys; hints untouched", () => {
  const input = {
    resource: [
      { name: "db_pass", value: "p@ss", private: true },
      { name: "region", value: "us-east-1", private: false },
    ],
    service: { type: "gcm", config: { api_key: KEY, sender_id: "123" } },
    app: { api_key: null, api_key_hint: "…5a88" },
  };
  assert.deepEqual(maskSecrets(input, {}), {
    resource: [
      { name: "db_pass", value: SECRET_MASK, private: true },
      { name: "region", value: "us-east-1", private: false },
    ],
    service: { type: "gcm", config: { api_key: SECRET_MASK, sender_id: "123" } },
    app: { api_key: null, api_key_hint: "…5a88" },
  });
  const created = maskSecrets({ resource: [{ id: 6, api_key: KEY, secret: "s" }] }, {}, { keepApiKeys: true });
  assert.deepEqual(created, { resource: [{ id: 6, api_key: KEY, secret: SECRET_MASK }] }, "create_app keeps only the key");
});

test("maskSecrets with a manifest: type-specific secret fields and user-named maps", () => {
  const manifest = parseSecretFieldManifest({
    gcm: { secret: ["api_key", "certificate"], maps: [] },
    snowflake: { secret: ["key", "passcode", "password"], maps: [] },
    nodejs: { secret: [], maps: ["config"] },
  });
  const records = {
    resource: [
      { id: 31, type: "gcm", config: { api_key: KEY, certificate: "-----BEGIN PRIVATE KEY-----x", sender_id: "123" } },
      { id: 40, type: "snowflake", config: { username: "etl", passcode: "123456", key: "pem", role: "ETL" } },
      { id: 32, type: "nodejs", config: { content: "return 1", config: { STRIPE_KEY: "sk_live_x", REGION: "us" } } },
      { id: 50, type: "mysql", config: { host: "db", certificate: "public" } },
    ],
  };
  const out = maskSecrets(records, {}, { manifest }) as typeof records;
  assert.deepEqual(out.resource[0].config, { api_key: SECRET_MASK, certificate: SECRET_MASK, sender_id: "123" });
  assert.deepEqual(out.resource[1].config, { username: "etl", passcode: SECRET_MASK, key: SECRET_MASK, role: "ETL" });
  assert.deepEqual(out.resource[2].config, { content: "return 1", config: { STRIPE_KEY: SECRET_MASK, REGION: "us" } });
  assert.deepEqual(out.resource[3].config, { host: "db", certificate: "public" }, "types outside the manifest keep name rules only");

  // Without the manifest, the name rules can't know these fields.
  const plain = maskSecrets(records, {}) as typeof records;
  assert.equal(plain.resource[0].config.certificate, "-----BEGIN PRIVATE KEY-----x");
  assert.equal((plain.resource[2].config.config as Record<string, string>).STRIPE_KEY, "sk_live_x");
  assert.equal(plain.resource[1].config.key, "pem", "a secret named just `key` is the manifest's job");
});

test("parseSecretFieldManifest: keeps valid entries, drops junk, can't reach the prototype", () => {
  assert.equal(parseSecretFieldManifest(null), undefined);
  assert.equal(parseSecretFieldManifest(["x"]), undefined);
  assert.equal(parseSecretFieldManifest({ a: { secret: "password" }, b: 5, "": { secret: ["x"] } }), undefined);
  const m = parseSecretFieldManifest({ smtp_email: { secret: ["password", 7, ""], maps: null }, constructor: { maps: ["options"] } });
  assert.deepEqual(JSON.parse(JSON.stringify(m)), { smtp_email: { secret: ["password"], maps: [] }, constructor: { secret: [], maps: ["options"] } });
  assert.equal(Object.getPrototypeOf(m), null);
  const huge = parseSecretFieldManifest({ t: { secret: Array.from({ length: 1000 }, (_, i) => `f${i}`) } });
  assert.equal(huge?.t.secret.length, 200);
  // A record whose type matches an Object.prototype name must not crash or mask anything extra.
  assert.deepEqual(maskSecrets({ type: "toString", config: { host: "x" } }, {}, { manifest: parseSecretFieldManifest({ gcm: { secret: ["api_key"] } }) }), {
    type: "toString",
    config: { host: "x" },
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
