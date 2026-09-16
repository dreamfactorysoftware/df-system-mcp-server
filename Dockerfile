# syntax=docker/dockerfile:1

# Sidecar image. Runs the committed build/ (CI keeps it in step with src/) with
# production dependencies only. The default deployment is a daemon on the
# DreamFactory host, started by df-mcp-server's scripts/start-system-daemon.sh;
# see README "Running".
# Optional runtime env (see README): MCP_INTERNAL_KEY, SESSION_TTL_SECONDS.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3700
ENV HOST=0.0.0.0
# Default DreamFactory base — override at runtime via compose env.
ENV DREAMFACTORY_URL=http://web/api/v2

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY build ./build

EXPOSE 3700

# BusyBox wget on alpine resolves `localhost` to ::1 first, which our server
# (bound to 0.0.0.0 → IPv4 only) refuses. Use 127.0.0.1 explicitly.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

USER node
CMD ["node", "build/index.js"]
