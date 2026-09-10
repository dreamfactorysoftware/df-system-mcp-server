# Changelog

All notable changes to `df-system-mcp-server` are documented here.

## Unreleased

### Security
- App API keys are no longer sent to the LLM. `list_apps`, `get_app` and
  `call_system_api` rewrite every `api_key` property, at any depth (single
  records, `{ resource: [...] }`, related records such as `app_by_role_id`),
  to `api_key: null` plus `api_key_hint: "…" + last 4 characters` (bare `"…"`
  for keys under 16 characters, `null` for no key). Helper: `src/redact.ts`.
- `create_app` still returns the real new key, once; its description now says so.

### Added
- `MCP_EXPOSE_API_KEYS=true` env var disables the masking (default: masked).
- `tests/redact.test.ts` (unit) and a proxy-contract case covering masking in
  `list_apps`, `get_app`, `call_system_api` and the unmasked `create_app`.

### Changed
- `get_app` / `list_apps` descriptions no longer advertise the `api_key`
  field ("Crucially, the response includes the api_key field…").

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
