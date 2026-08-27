# Changelog

All notable changes to `df-system-mcp-server` are documented here.

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
