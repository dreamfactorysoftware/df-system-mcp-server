# syntax=docker/dockerfile:1

# Single-stage build: tsx handles TS at runtime so the image needs no tsc
# step (tsc is still run in CI via `npm run build`). Startup cost of
# tsx-transpile is sub-second and only paid once.
# Optional runtime env (see README): MCP_INTERNAL_KEY, SESSION_TTL_SECONDS.
FROM node:20-alpine
WORKDIR /app
# Defer NODE_ENV=production until AFTER `npm install`. With production set,
# npm skips devDependencies and tsx (our runtime transpiler) never lands.
ENV PORT=3700
ENV HOST=0.0.0.0
# Default DreamFactory base — override at runtime via compose env.
ENV DREAMFACTORY_URL=http://web/api/v2

COPY package.json package-lock.json* ./
# Force-install dev deps so tsx is available at runtime.
RUN npm install --include=dev --no-audit --no-fund
ENV NODE_ENV=production

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3700

# BusyBox wget on alpine resolves `localhost` to ::1 first, which our server
# (bound to 0.0.0.0 → IPv4 only) refuses. Use 127.0.0.1 explicitly.
# Also raise start-period: tsx-transpiling the SDK on first request can take
# several seconds on cold start.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3700/health || exit 1

USER node
# tsx transpiles on the fly, no separate build artifact.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
