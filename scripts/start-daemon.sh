#!/usr/bin/env sh
# Bare-node launcher for df-system-mcp-server (no Docker).
#
# Usage:
#   PORT=3700 HOST=127.0.0.1 DREAMFACTORY_URL=http://localhost/api/v2 scripts/start-daemon.sh
#
# Environment passthrough (all optional):
#   PORT                 listen port            (default 3700)
#   HOST                 listen address         (default 0.0.0.0)
#   DREAMFACTORY_URL     DF base URL incl. /api/v2 (default http://web/api/v2);
#                        overridden per-session by X-Mcp-Base-Url from df-mcp-server
#   MCP_INTERNAL_KEY     shared secret; when set, every /mcp* request must send X-Mcp-Internal-Key
#   SESSION_TTL_SECONDS  idle MCP session eviction window (default 1800)
#   MCP_EXPOSE_API_KEYS  "true" sends full app API keys to the LLM (default: masked)
set -eu
cd "$(dirname "$0")/.."
if [ ! -x node_modules/.bin/tsx ]; then
  echo "node_modules/.bin/tsx not found — run 'npm install' first" >&2
  exit 1
fi
export PORT="${PORT:-3700}"
export HOST="${HOST:-0.0.0.0}"
export DREAMFACTORY_URL="${DREAMFACTORY_URL:-http://web/api/v2}"
exec node_modules/.bin/tsx src/index.ts
