# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS build
WORKDIR /repo
# better-sqlite3 has a native compile step on alpine; install build deps.
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json pnpm-lock.yaml ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/core/package.json ./packages/core/
RUN pnpm install --filter @social-manifold/core... --frozen-lockfile
COPY packages/contracts ./packages/contracts
COPY packages/core ./packages/core
RUN pnpm --filter @social-manifold/contracts build
RUN pnpm --filter @social-manifold/core build
RUN pnpm --filter @social-manifold/core deploy --prod /out

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
ENV NODE_ENV=production
ENV CORE_IDEMPOTENCY_DB=/var/lib/social-manifold/idempotency.db
ENV CORE_PERSONAS_ROOT=/var/social-manifold/personas
ENV CHILD_DISCORD_SOCKET_PATH=/run/social-manifold/children/discord.sock
CMD ["node", "dist/server.js"]
