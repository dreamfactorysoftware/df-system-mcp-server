# df-system-mcp-server

Standalone Node/TypeScript MCP server that exposes DreamFactory's **control-plane System API**
(`/api/v2/system/*`) as MCP tools. Built so an LLM can administer a DreamFactory instance
(create services, define roles, mint API keys, manage admins) over natural language.

This server is **distinct** from:

- `df-mcp-server` — Laravel daemon proxy for **data-plane** table CRUD.
- `df-mcp` — Claude Desktop extension for data-plane CRUD.
- `df-ai-backend` — Express MCP server for data-plane CRUD using per-API session manager.

## Endpoints

| Method  | Path     | Purpose                                                                        |
| ------- | -------- | ------------------------------------------------------------------------------ |
| `GET`   | `/health` | Liveness probe: `{ status, service, version, tools, dreamfactory_url }`        |
| `POST`  | `/mcp`    | MCP JSON-RPC requests (Streamable HTTP transport).                             |
| `GET`   | `/mcp`    | SSE stream for server-to-client notifications. Requires `Mcp-Session-Id`.      |
| `DELETE`| `/mcp`    | Explicit MCP session termination. Requires `Mcp-Session-Id`.                   |

Default port: **3700** (override with `PORT`).

## Authentication

Every tool call needs a DreamFactory session token. Send it on **every HTTP request to `/mcp`**
under either header:

- `X-DreamFactory-Session-Token: <token>` (preferred)
- `Authorization: Bearer <token>`

The token is forwarded to DreamFactory as `X-DreamFactory-Session-Token`. The token is
bound to the MCP session id on `initialize` and refreshed on every subsequent request.

If no token is bound at tool-call time, the tool returns an `authentication required` error.

## Configuration

| Env var            | Default                | Purpose                                              |
| ------------------ | ---------------------- | ---------------------------------------------------- |
| `PORT`             | `3700`                 | HTTP listen port.                                    |
| `HOST`             | `0.0.0.0`              | HTTP listen host.                                    |
| `DREAMFACTORY_URL` | `http://web/api/v2`    | DreamFactory base URL (no trailing slash required).  |

## Tools

17 tools across six families. See `src/tools/` for full descriptions and zod schemas.

- **Services** (5): `list_services`, `get_service`, `create_service`, `update_service`, `delete_service`
- **Meta** (3): `list_service_types`, `get_service_type_schema`, `get_environment`
- **Roles** (4): `list_roles`, `create_role`, `get_role`, `update_role`
- **Apps / API keys** (3): `list_apps`, `create_app`, `get_app`
- **Admins** (1): `list_admins`
- **Escape hatch** (1): `call_system_api` — any `system/*` or `user/*` path the dedicated tools miss.

## Development

```bash
npm install
npm run build          # tsc → build/
npm run dev            # tsx watch mode
npm test               # smoke test
```

## Docker

```bash
docker build -t df-system-mcp .
docker run --rm -p 3700:3700 \
  -e DREAMFACTORY_URL=http://web/api/v2 \
  --network dreamfactory_default \
  df-system-mcp
```

## Calling from the PHP orchestrator

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
