# Changelog

All notable changes to `df-system-mcp-server` are documented here.

## 0.4.1 — 2026-09-14

### Security
- Tool results no longer carry secrets beyond app API keys. `get_environment`
  and `call_system_api system/environment` returned the platform
  `license_key`, and service configs returned credentials DreamFactory doesn't
  mask (an MCP service's `oauth_client_secret`, SMTP and AD passwords, cloud
  email keys). Every tool response now replaces properties whose names look
  like secrets (passwords, passphrases, secrets, tokens, private keys,
  license/app/encryption keys, credentials, connection strings, DSNs, and
  `key`) with DreamFactory's protection mask `**********`, at any depth, and
  masks `value` on records with `private: true` (private lookups). Null,
  numbers and booleans pass through. `api_key` keeps its `api_key_hint`
  masking, and `create_app` still returns the new key.
- Credentials stored as name/value entries are masked too. RWS services
  returned `config.headers[].value` (e.g. `Authorization: Basic ...`) and
  `config.parameters[].value` (e.g. `api_key=...`) in the clear, because the
  secret sits next to a `name`. A `value` is now masked when its sibling
  `name` looks like a credential (Authorization, Proxy-Authorization, Cookie,
  Set-Cookie, X-API-Key, or containing auth, token, secret, pass, key,
  session, credential, bearer, or `sig` at a word start). Other headers and
  parameters (Accept, limit, ...) stay readable for debugging, and empty
  values stay empty. Properties named `authorization`, `auth` or `cookie` are
  masked as well.
- Curl options (an RWS service's `config.options`) are masked by option name,
  keyed as `CURLOPT_X`, `X` or the numeric constant: options carrying
  credentials (USERPWD, PROXYUSERPWD, PASSWORD, KEYPASSWD, XOAUTH2_BEARER,
  COOKIE, POSTFIELDS, LOGIN_OPTIONS, ...) and the credential lines of
  HTTPHEADER / PROXYHEADER (`Authorization: **********`). Other options stay
  readable. A password inside any URL is masked in place
  (`http://user:**********@proxy:3128`).
- Write requests drop a property set to exactly `**********` directly on the
  body or directly in `config`, so sending back a config read through this
  server leaves the stored secret unchanged. A mask anywhere deeper, or inside
  a longer string, is refused instead of sent: DreamFactory stores such values
  whole (RWS headers and parameters are deleted and recreated on save,
  `options` is one attribute), so the mask would be saved as the value.

### Added
- `MCP_EXPOSE_SECRETS=true` turns secret masking off.

### Fixed
- `get_service`, `update_service` and `delete_service` accept a service name,
  as their descriptions say. They passed the name straight into
  `system/service/{id}`, which DreamFactory answers with a 404; a name is now
  resolved to its id with a `name='...'` filter first. Values that can't be a
  service name are rejected without a request.

## 0.4.0 — 2026-09-14

Runs as a daemon on the DreamFactory host, not only as a sidecar container.
df-mcp-server's `scripts/start-system-daemon.sh` starts it from
`vendor/dreamfactory/df-system-mcp-server`.

### Added
- `composer.json` (`dreamfactory/df-system-mcp-server`), so composer installs
  the daemon next to df-mcp-server.
- `build/` is committed. `npm start` and `scripts/start-daemon.sh` run
  `node build/index.js` with production dependencies only (no `tsx` at
  runtime). CI fails when `build/` doesn't match `src/`.
- `MCP_SYSTEM_DAEMON_PORT` / `MCP_SYSTEM_DAEMON_HOST`, which take precedence
  over `PORT` / `HOST`.
- `MCP_TRUST_LOOPBACK` (default on): when the daemon listens on loopback, local
  callers may set `X-Mcp-Base-Url` without `MCP_INTERNAL_KEY`, as with
  df-mcp-server's data daemon. `/health` reports `listen` and `loopback_trust`.
- `engines.node` `>=20`.

### Changed
- Defaults suit a daemon next to DreamFactory: listen on `127.0.0.1` (was
  `0.0.0.0`) and call DreamFactory on `http://127.0.0.1/api/v2` (was
  `http://web/api/v2`). The Docker image and `docker-compose.example.yml` still
  set `0.0.0.0` and `http://web/api/v2`, so sidecars behave as before.
- The Docker image runs the committed build with production dependencies
  (was `tsx` plus dev dependencies), and its healthcheck follows `$PORT`.

## 0.3.0 — 2026-09-10

Adds a usage-audit tool and stops sending app API keys to the LLM. Tool count
17 → 18; mirror the new name in the admin UI catalogue (`system-mcp-tools.ts`).

### Security
- App API keys are no longer sent to the LLM. `list_apps`, `get_app` and
  `call_system_api` rewrite every `api_key` property, at any depth (single
  records, `{ resource: [...] }`, related records such as `app_by_role_id`),
  to `api_key: null` plus `api_key_hint: "…" + last 4 characters` (bare `"…"`
  for keys under 16 characters, `null` for no key). Helper: `src/redact.ts`.
- `create_app` still returns the real new key, once; its description now says so.

### Added
- `get_access_audit` (read-only, `src/tools/audit.ts`): wraps
  `GET system/access_usage` (df-system 0.7.0+) with `subject` (`app`|`role`|`user`,
  default `app`), `stale_days` (int ≥ 1, default 90) and `only_flagged`
  (client-side filter to rows where `never_used`, `stale`,
  `disabled_but_attempted` or `role_unreferenced` is true; adds
  `meta.only_flagged` and `meta.unfiltered_count`). Always sends
  `include_never_used=true`. A 404 becomes a "requires a DreamFactory version
  that provides system/access_usage (df-system 0.7.0 or later)" tool error; a
  403 becomes a permission error. The description tells the model to disable
  before deleting, that "never used" only covers the time since
  `meta.tracking_started_at`, and that `last_service`/`last_status` describe
  the last use (401/403 only move `last_denied_at`). It can be hidden with
  `disabled_tools`.
- Proxy-contract cases: `get_access_audit` param passthrough, `only_flagged`,
  argument validation, 404/403 handling, `disabled_tools`.
- `MCP_EXPOSE_API_KEYS=true` env var disables the masking (default: masked).
- `tests/redact.test.ts` (unit) and a proxy-contract case covering masking in
  `list_apps`, `get_app`, `call_system_api` and the unmasked `create_app`.

### Changed
- `get_app` / `list_apps` descriptions no longer advertise the `api_key`
  field ("Crucially, the response includes the api_key field…").
- `TOOL_NAMES` gains `get_access_audit` (between `list_admins` and
  `call_system_api`); smoke test expects 18 tools.
- `SERVER_VERSION` and `package.json` bumped to `0.3.0` (reported by `/health`).

## 0.2.0 — 2026-08-27

Speaks the `df-mcp-server` (PHP) daemon proxy contract so a DreamFactory
`system_mcp` ("System API MCP Server") service can front this daemon with
OAuth 2.1 and the `/api/v2/{service}/rpc` bridge.

### Added
- Routes `POST/GET/DELETE /mcp/:serviceName` (same handlers as `/mcp`; the
  service name is only used in logs) and `GET /ping` (alias of `/health`).
- Envelope unwrap: `POST` bodies of the form
  `{ "_mcpPayload", "_mcpConfig", "_mcpAvailableServices" }` are unwrapped
  before MCP handling; `GET`/`DELETE` read the service config from the
  `X-Mcp-Config` header. Bare JSON-RPC bodies still work (direct mode).
- Per-session context now carries `apiKey` (`X-DreamFactory-API-Key`),
  `baseUrl` (`X-Mcp-Base-Url`, overrides `DREAMFACTORY_URL`) and `traceId`
  (`X-DreamFactory-Trace-Id`); all are forwarded on DreamFactory calls.
- `MCP_INTERNAL_KEY` env: when set, every `/mcp*` request must carry a
  matching `X-Mcp-Internal-Key` or receive `403 {code:-32001}`.
- `disabled_tools` from the service config: listed tools are not registered
  on that session's MCP server (unknown names ignored). `custom_tools` is
  ignored (logged once at debug level).
- Idle-session eviction (`SESSION_TTL_SECONDS`, default 1800).
- `/health` reports `mode: "stateful"` and `active_sessions`.
- `tests/proxy-contract.test.ts` (mock DreamFactory, envelope round-trip,
  header forwarding, 403 gate, `disabled_tools`, `call_system_api` path guard).
  `npm test` now runs every `tests/*.test.ts`.
- Ops: `scripts/start-daemon.sh`, `docker-compose.example.yml`,
  `.github/workflows/ci.yml` (Node 20 + 22).
- `X-Mcp-One-Shot: 1` on `initialize` closes the session after its first
  answered request, so `rpcStateless()`-style callers that never `DELETE`
  do not pin a McpServer for `SESSION_TTL_SECONDS`.
- `MCP_ALLOWED_BASE_URLS` env (extra origins untrusted callers may use in
  `X-Mcp-Base-Url`).
- `tests/path-guard.test.ts`, `tests/trust.test.ts` (unit), plus proxy-contract
  cases for dot-segment bypasses, 404 on unknown session, base-URL hijack and
  one-shot teardown; smoke case for direct-mode base-URL trust.

### Security
- `call_system_api` path guard now validates the resolved URL
  (`src/path-guard.ts`): `system/../db/_table/x`, `/system/%2e%2e/...`,
  backslashes, absolute URLs and embedded `?`/`#` are rejected. Previously a
  dot-segment path passed the `startsWith('system/')` check and WHATWG URL
  normalisation in `fetch` sent it to the data plane.
- `X-Mcp-Base-Url` is trusted only from internal-key-verified callers or
  allowlisted origins, and is bound at `initialize` only (never rebound on a
  later request carrying the same `Mcp-Session-Id`).
- Internal-key comparison uses `crypto.timingSafeEqual`.

### Fixed
- Unknown / evicted `Mcp-Session-Id` now returns
  `404 {code:-32001, message:"Session not found"}` on POST/GET/DELETE (per the
  Streamable HTTP spec and the SDK transport) instead of a misleading 400, so
  SDK clients re-initialize instead of retrying a dead id.

### Changed
- `@modelcontextprotocol/sdk` pinned to `~1.18.2`: 1.23+ (zod v3/v4 compat
  types) makes `tsc` blow past 1.4 GB heap with TS2589 on every
  `server.tool()` call; 1.18.x type-checks in ~150 MB. Bump deliberately.
- `ToolTextResponse` gained index signatures so it satisfies the SDK's
  `CallToolResult` type (previously a latent `tsc` error).
- `registerTools(server, { disabled })` and per-family `registerXxxTools`
  accept the option; tools are declared through `defineTool()`.
- `SERVER_VERSION` bumped to `0.2.0`.

## 0.1.0 — 2026-06-09

Initial import: 17 System API tools (services, service types/environment,
roles, apps/API keys, admins, `call_system_api` escape hatch) over MCP
Streamable HTTP on `POST/GET/DELETE /mcp`, authenticated by
`X-DreamFactory-Session-Token` / `Authorization: Bearer`. Docker image
(node:20-alpine, tsx runtime) and smoke test.
