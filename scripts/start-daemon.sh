#!/usr/bin/env sh
# Bare-node launcher for df-system-mcp-server (no Docker).
#
# On a DreamFactory host, use df-mcp-server's scripts/start-system-daemon.sh
# instead: it finds this package under vendor/ and installs its dependencies.
#
# Usage:
#   npm ci --omit=dev && scripts/start-daemon.sh
#
# Environment passthrough (all optional):
#   MCP_SYSTEM_DAEMON_PORT  listen port (or PORT; default 3700)
#   MCP_SYSTEM_DAEMON_HOST  listen address (or HOST; default 127.0.0.1)
#   DREAMFACTORY_URL     DF base URL incl. /api/v2 (default http://127.0.0.1/api/v2);
#                        overridden per session by X-Mcp-Base-Url from df-mcp-server
#   MCP_INTERNAL_KEY     shared secret; when set, every /mcp* request must send X-Mcp-Internal-Key
#   MCP_TRUST_LOOPBACK   "false" ignores local callers' X-Mcp-Base-Url on a loopback bind
#   SESSION_TTL_SECONDS  idle MCP session eviction window (default 1800)
#   MCP_EXPOSE_API_KEYS  "true" sends full app API keys to the LLM (default: masked)
set -eu
cd "$(dirname "$0")/.."
if [ ! -f build/index.js ]; then
  echo "build/index.js not found — run 'npm install && npm run build' first" >&2
  exit 1
fi
if [ ! -d node_modules/@modelcontextprotocol/sdk ]; then
  echo "dependencies not installed — run 'npm ci --omit=dev' first" >&2
  exit 1
fi
export NODE_ENV="${NODE_ENV:-production}"
exec node build/index.js
