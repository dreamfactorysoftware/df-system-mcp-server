# df-system-mcp-server

Standalone Node/TypeScript MCP server that exposes DreamFactory's **control-plane System API**
(`/api/v2/system/*`) as MCP tools. Built so an LLM can administer a DreamFactory instance
(create services, define roles, mint API keys, inspect admins/environment) over natural language.

This server is **distinct** from:

- `df-mcp-server` (PHP) — the DreamFactory package that registers the `mcp` (data-plane) and
  `system_mcp` (this server) service types, provides OAuth 2.1 and proxies to the daemons.
- `df-mcp-server/daemon` — the data-plane Node daemon (tables / schema / procs / files).
- `df-ai-backend` — Express MCP server for data-plane CRUD using a per-API session manager.

It runs in two modes at once, on the same port:

| Mode | Caller | Route | Body |
| ---- | ------ | ----- | ---- |
| **Proxied** | `df-mcp-server` (PHP `McpDaemonClient`) for a `system_mcp` service | `/mcp/{service}` | PHP envelope `{ _mcpPayload, _mcpConfig, _mcpAvailableServices }` |
| **Direct** | `df-ai-assistant`, any MCP client with a DF session token | `/mcp` | bare JSON-RPC |

## Endpoints

| Method   | Path                      | Purpose |
| -------- | ------------------------- | ------- |
| `GET`    | `/health`, `/ping`        | Liveness: `{ status, service, version, tools, mode: "stateful", active_sessions, dreamfactory_url }` |
| `POST`   | `/mcp`, `/mcp/:service`   | MCP JSON-RPC requests (Streamable HTTP transport). Accepts bare JSON-RPC or the PHP envelope. |
| `GET`    | `/mcp`, `/mcp/:service`   | SSE stream for server-to-client notifications. Requires `Mcp-Session-Id`. |
| `DELETE` | `/mcp`, `/mcp/:service`   | Explicit MCP session termination. Requires `Mcp-Session-Id`. |

`:service` is the DreamFactory service name the PHP proxy routed through; it is only used in logs.
Default port: **3700** (override with `PORT`).

### Proxy contract (what `df-mcp-server` sends)

Request headers (read per request; the session token / API key / trace id are re-bound on
every call, `X-Mcp-Base-Url` is bound at `initialize` only):

| Header | Meaning |
| ------ | ------- |
| `X-DreamFactory-Session-Token` | DF session token of the OAuth'd user. **Required** for tool calls. |
| `X-DreamFactory-API-Key` | Optional DF API key (`app_id` on the service). Forwarded verbatim. |
| `X-Mcp-Base-Url` | DF base URL ending in `/api/v2`. Overrides `DREAMFACTORY_URL` for that session. **Trusted only** from callers that passed the `MCP_INTERNAL_KEY` gate, or whose origin is on the allowlist (`DREAMFACTORY_URL` origin + `MCP_ALLOWED_BASE_URLS`); otherwise ignored with a warning. Bound at `initialize`, never rebound. |
| `X-DreamFactory-Trace-Id` | Optional trace id, forwarded back on every DF call. |
| `X-Mcp-Internal-Key` | Required when `MCP_INTERNAL_KEY` is set (else `403 {code:-32001}`). Compared in constant time. |
| `X-Mcp-One-Shot` | `1` on `initialize` marks the session single-use: it is closed as soon as the first non-lifecycle JSON-RPC request (e.g. `tools/call`) has been answered. Intended for the PHP `rpcStateless()` bridge (`POST /api/v2/{svc}/rpc`), which never sends `DELETE`. |
| `X-Mcp-Config` | `GET`/`DELETE` only: JSON service config (POST carries it in the envelope). |
| `Mcp-Session-Id`, `Last-Event-ID`, `Content-Type`, `Accept` | Standard Streamable HTTP headers, passed through. |

POST body envelope:

```json
{
  "_mcpPayload": { "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "...": "..." } },
  "_mcpConfig": { "disabled_tools": ["delete_service"], "custom_tools": [], "app_id": null },
  "_mcpAvailableServices": []
}
```

- `_mcpPayload` is the JSON-RPC message; `isInitializeRequest` is evaluated on it.
- `_mcpConfig.disabled_tools` — tool names that are **not registered** for that session
  (unknown names ignored). `custom_tools` is ignored (this server has no custom-tool runtime).
- `_mcpAvailableServices` is ignored (System API tools do not depend on data services).

Responses are whatever the MCP SDK's Streamable HTTP transport produces (`application/json`
or `text/event-stream`), plus `Mcp-Session-Id` on `initialize`. The PHP client streams SSE
through untouched.

Session errors (all `POST`/`GET`/`DELETE` routes):

| Status | Meaning |
| ------ | ------- |
| `400 {code:-32000}` | No `Mcp-Session-Id` and the body is not an `initialize` request (POST), or the header is missing (GET/DELETE). |
| `404 {code:-32001, message:"Session not found"}` | `Mcp-Session-Id` is unknown — evicted after `SESSION_TTL_SECONDS`, closed by `DELETE`/one-shot, or the daemon restarted. Clients must re-`initialize` (this is the Streamable HTTP spec behaviour and what the MCP SDK client keys on). |
| `403 {code:-32001}` | `MCP_INTERNAL_KEY` set and header missing/wrong. |

### Direct mode (df-ai-assistant)

`POST /mcp` with `X-DreamFactory-Session-Token` (or `Authorization: Bearer <token>`) and,
after `initialize`, `Mcp-Session-Id`. No envelope. This contract is unchanged from 0.1.0
and is covered by `tests/smoke.test.ts`.

## Authentication

Every tool call needs a DreamFactory session token, bound to the MCP session on `initialize`
and refreshed on every subsequent request. If no token is bound at tool-call time, the tool
returns an `authentication required` error. Tools execute with exactly the DreamFactory role
of that token — non-admin tokens cannot administer the instance. Tokens and keys are never logged.

## Configuration

| Env var               | Default             | Purpose |
| --------------------- | ------------------- | ------- |
| `MCP_SYSTEM_DAEMON_PORT` (or `PORT`) | `3700` | HTTP listen port. The prefixed name wins, so a generic `PORT` on the DreamFactory host doesn't move the daemon. |
| `MCP_SYSTEM_DAEMON_HOST` (or `HOST`) | `127.0.0.1` | HTTP listen address. The Docker image sets `0.0.0.0`. |
| `DREAMFACTORY_URL`    | `http://127.0.0.1/api/v2` | Default DreamFactory base URL (no trailing slash required). Overridden per session by `X-Mcp-Base-Url`. The Docker image sets `http://web/api/v2`. |
| `MCP_TRUST_LOOPBACK`  | `true`              | When the daemon listens on loopback, local callers may set `X-Mcp-Base-Url` without the internal key (see [Trust boundary](#trust-boundary)). `false` requires the key or the allowlist even locally. |
| `MCP_INTERNAL_KEY`    | *(unset)*           | Shared secret. When set, every `/mcp*` request must send a matching `X-Mcp-Internal-Key`. Set the same value as `MCP_INTERNAL_KEY` in the DreamFactory `.env`. |
| `SESSION_TTL_SECONDS` | `1800`              | Idle MCP sessions older than this are closed and their auth context dropped (`0` disables). Requests with an evicted id get `404 Session not found`. |
| `MCP_ALLOWED_BASE_URLS` | *(unset)*         | Comma-separated extra origins that untrusted callers may name in `X-Mcp-Base-Url` (the `DREAMFACTORY_URL` origin is always allowed). Not needed when `MCP_INTERNAL_KEY` is set. |
| `MCP_EXPOSE_API_KEYS` | `false`             | `true` disables API-key masking (app keys in `list_apps`, `get_app` and `call_system_api`, and `api_key` in service configs), so full keys are sent to the LLM. Leave unset in production; see [Secret masking](#secret-masking). |
| `MCP_EXPOSE_SECRETS`  | `false`             | `true` disables masking of other secrets (license key, passwords, client secrets, tokens, private lookups) in every tool response. Leave unset in production; see [Secret masking](#secret-masking). |

### Trust boundary

Anything that can reach this port can send a DreamFactory session token and have the daemon
act with it — that is by design (the token is the authorisation). What the daemon must **not**
allow is a caller redirecting where that token is sent. Therefore:

- `X-Mcp-Base-Url` is honoured only from callers that presented the correct `X-Mcp-Internal-Key`
  (the DreamFactory PHP proxy), from local callers when the daemon listens on loopback (the
  default deployment next to DreamFactory, where only processes on that host can reach it;
  `MCP_TRUST_LOOPBACK=false` turns this off), or from callers whose origin is on the allowlist.
  Everyone else gets `DREAMFACTORY_URL`. Set `MCP_INTERNAL_KEY` whenever the daemon listens
  on a network interface.
- The base URL is fixed at `initialize`; knowing a live `Mcp-Session-Id` does not let a caller
  rebind that session's base URL.
- `call_system_api` validates the **resolved** URL: `system/../db/_table/x`, `%2e%2e`,
  backslashes, absolute URLs and embedded `?`/`#` are all rejected before any request is made.
- Keep the daemon on loopback (the default) or a private Docker network; it has no user-facing
  auth of its own. If a same-host reverse proxy forwards outside traffic to it, set
  `MCP_TRUST_LOOPBACK=false` and `MCP_INTERNAL_KEY`.

### DreamFactory side

In the DreamFactory `.env` (df-mcp-server >= 1.4 / DF 7.7.x):

```
MCP_SYSTEM_DAEMON_ENABLED=true
MCP_SYSTEM_DAEMON_URL=http://127.0.0.1:3700       # the default; http://df-system-mcp:3700 for a sidecar
MCP_INTERNAL_KEY=change-me                        # must match this daemon; recommended for a sidecar
```

Then create a service of type **System API MCP Server** (`system_mcp`), e.g. `sysmcp`, and point
an MCP client at `https://<df-host>/mcp/sysmcp` (OAuth 2.1 with dynamic client registration) or
call `POST /api/v2/sysmcp/rpc` with a DF session token.

## Tools

18 tools across seven families. See `src/tools/` for full descriptions and zod schemas.
The canonical list is `TOOL_NAMES` in `src/tools/index.ts` (the DreamFactory admin UI mirrors it).

- **Services** (5): `list_services`, `get_service`, `create_service`, `update_service`, `delete_service`
- **Meta** (3): `list_service_types`, `get_service_type_schema`, `get_environment`
- **Roles** (4): `list_roles`, `create_role`, `get_role`, `update_role`
- **Apps / API keys** (3): `list_apps`, `create_app`, `get_app` (keys masked except on `create_app`, see below)
- **Admins** (1): `list_admins`
- **Access audit** (1): `get_access_audit` — read-only; last used / last denied per app, role or user,
  with `never_used`, `stale`, `disabled_but_attempted` and `role_unreferenced` flags. See below.
- **Escape hatch** (1): `call_system_api` — any `system/*` or `user/*` path the dedicated tools miss.

Any of these can be hidden per DreamFactory service via `disabled_tools` in the service config.

### `get_access_audit`

Wraps `GET /api/v2/system/access_usage`, which **requires df-system 0.7.0 or later** on the
DreamFactory side. Older versions answer 404; the tool turns that into an error telling the model
the feature needs an upgrade. A 403 (restricted admin without `system/access_usage` access) becomes
a permission error.

| Argument | Default | Sent to DreamFactory as |
| -------- | ------- | ----------------------- |
| `subject` | `app` | `subject=app\|role\|user` |
| `stale_days` | `90` | `stale_days` (integer ≥ 1) |
| `only_flagged` | `false` | not sent. The tool keeps only rows where `never_used`, `stale`, `disabled_but_attempted` or `role_unreferenced` is `true`, and adds `meta.only_flagged` and `meta.unfiltered_count`. |
| *(always)* | | `include_never_used=true` |

The description tells the model to recommend disabling (`is_active=false`) before deleting, and that
`never_used` only means no traffic has been recorded since `meta.tracking_started_at` (the earliest
recorded activity; `null` when nothing has been recorded yet). `last_service` / `last_status` describe
the last use (any request not rejected with 401/403); a 401/403 only moves `last_denied_at`.
`meta.ledger_available` says whether `requests_30d` / `top_services` are populated.

### Secret masking

Tool results go to an LLM, and from there into provider logs and DreamFactory's prompt logs, so
credentials are masked by default.

**Secrets in every response.** DreamFactory returns more than API keys: `system/environment` includes
the platform `license_key`, and service configs include credentials that DreamFactory itself doesn't
mask (for example SMTP and Active Directory passwords, or an MCP service's `oauth_client_secret`).
Every tool response replaces properties whose names look like secrets with DreamFactory's own
protection mask, `"**********"`, at any depth:

- names containing `password`, `passphrase`, `passcode`, `secret`, `token`, `private_key`, `api_key`
  (or `apikey`), `access_key`, `license_key`, `app_key`, `encryption_key`, `credentials`,
  `connection_string` or `dsn`, plurals too (camelCase names count too, e.g. `clientSecret`). A bare
  `key` isn't matched: DreamFactory uses it for key/value descriptors and AWS access key IDs, and the
  type-aware list below covers configs whose secret is named `key` (Snowflake)
- except descriptive names such as `token_endpoint`, `token_ttl`, `password_policy` or `secret_type`,
  and type names in descriptor records (at least two values are type names), such as the environment's
  login payload `{ "email": "string", "password": "string", "remember_me": "bool" }`; a real value in
  such a record is still masked
- `value` on any record whose `name` looks like a credential: Authorization, Proxy-Authorization,
  Cookie, Set-Cookie, X-API-Key, or a name containing `auth`, `token`, `secret`, `pass`, `key`,
  `session`, `credential`, `bearer`, or `sig` at a word start. This covers RWS
  `config.headers` / `config.parameters` entries such as `{ "name": "Authorization", "value": "Basic ..." }`
  or an `api_key` query parameter, while `Accept`, `limit` and the like stay readable. Records with
  `private: true` (private lookups) have `value` masked too.
- curl options (RWS `config.options`, keyed `CURLOPT_X`, `X` or by number) that carry credentials
  (USERPWD, PROXYUSERPWD, PASSWORD, KEYPASSWD, XOAUTH2_BEARER, COOKIE, POSTFIELDS, LOGIN_OPTIONS),
  and credential lines in HTTPHEADER / PROXYHEADER (`"Authorization: **********"`)
- a password inside any URL, in place: `http://user:**********@proxy:3128`
- only non-empty strings, objects and arrays are replaced; `null`, numbers and booleans pass through

**Type-aware fields.** Names don't reveal every credential (a push service's `certificate`, say), so
df-mcp-server also sends the daemon each installed service type's secret config fields, built from
DreamFactory's model metadata: fields the type encrypts or protects, and fields its config schema
types as a password or certificate (`username` and `account_name` stay readable). They arrive in the
proxy envelope as `_mcpSecretFields`:

```json
{ "gcm": { "secret": ["api_key", "certificate"], "maps": [] }, "nodejs": { "secret": [], "maps": ["config"] } }
```

On any record with that `type`, the `secret` fields of its `config` are masked. Keys of `maps` fields
(user-named key/value maps such as a script service's `config`) are masked when they look like
credentials (`STRIPE_KEY`, `DB_PASSWORD`). The list only adds masking; a client connecting to the
daemon directly, without df-mcp-server, gets the name rules above.

`list_service_types` and `get_service_type_schema` return type metadata unmasked. It describes fields
and holds no instance values, so masking could only corrupt it (the `key` descriptor of key/value fields,
a placeholder default URL). `call_system_api` masks every response, `system/service_type` included.

Write requests drop a property set to exactly `"**********"` directly on the body or directly in
`config`, so sending back a config read through this server leaves the stored secret unchanged. A mask
anywhere deeper, or inside a longer string, is refused with a tool error instead: DreamFactory stores
RWS `headers`, `parameters` and `options` as a whole, so the mask would be saved as the value. Send
those with real values, or leave them out of the request to keep them. To rotate a credential, send the
new value.
Set `MCP_EXPOSE_SECRETS=true` to turn this masking off.

**App API keys.** In every `list_apps`, `get_app` and `call_system_api` response,
each object property named `api_key`, at any depth (single records, `{ resource: [...] }` lists,
records nested via `related=` such as `app_by_role_id`), is rewritten as:

```json
{ "api_key": null, "api_key_hint": "…5a88" }
```

- `api_key_hint` is `"…"` plus the key's last 4 characters. Keys shorter than 16 characters get a
  bare `"…"`; a null or empty key gets `api_key_hint: null`.
- `create_app` is the exception: it returns the real new key once, because the caller needs it.
- `api_key` anywhere else (service configs such as gcm or rackspace) gets the secret mask `"**********"`.
- Set `MCP_EXPOSE_API_KEYS=true` to turn API-key masking off.

## Development

```bash
npm install
npm run build          # tsc → build/   (NODE_OPTIONS=--max-old-space-size=4096 if tsc OOMs)
npm run dev            # tsx src/index.ts
npm test               # runs every tests/*.test.ts (smoke + proxy contract)
```

`build/` is committed: DreamFactory installs this package with composer and runs
`node build/index.js` without a TypeScript toolchain. Run `npm run build` and commit the
result with every `src/` change; CI fails when `build/` is stale.

## Running

### On the DreamFactory host (default)

Composer installs this package next to df-mcp-server (`vendor/dreamfactory/df-system-mcp-server`).
df-mcp-server's `scripts/start-system-daemon.sh` (or `start-system-daemon-win.ps1`) installs the
production dependencies on first run and starts `node build/index.js` on `127.0.0.1:3700`,
calling DreamFactory back on `http://127.0.0.1/api/v2`. The DreamFactory Docker image starts it
next to the data daemon; on a VM, run the script from a systemd unit. No `.env` change is
needed: df-mcp-server already defaults `MCP_SYSTEM_DAEMON_URL` to `http://127.0.0.1:3700`.

### Docker sidecar

```bash
docker build -t df-system-mcp .
docker run --rm -p 3700:3700 \
  -e DREAMFACTORY_URL=http://web/api/v2 \
  --network dreamfactory_default \
  df-system-mcp
```

Or with the bundled example compose file (joins the `dreamfactory_default` network):

```bash
docker compose -f docker-compose.example.yml up -d --build
```

A sidecar listens on a network interface, so set `MCP_INTERNAL_KEY` on both sides and
`MCP_SYSTEM_DAEMON_BASE_URL=http://web` in DreamFactory.

### Bare node

```bash
npm ci --omit=dev
scripts/start-daemon.sh    # 127.0.0.1:3700, DreamFactory at http://127.0.0.1/api/v2
```

## Calling from the PHP orchestrator (direct mode)

The orchestrator is an MCP client. Use any MCP SDK that speaks Streamable HTTP, point it at
`http://df-system-mcp:3700/mcp`, set the auth header on every HTTP request, and invoke tools
by name. The expected response shape per tool is:

```json
{
  "content": [
    { "type": "text", "text": "<json-encoded DreamFactory response>" }
  ],
  "isError": false
}
```

Errors set `isError: true` and embed `{ error, status, operation, details }` in the text payload.

See `CHANGELOG.md` for release notes.
