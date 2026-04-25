# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json pnpm-lock.yaml ./
COPY packages/contracts/package.json ./packages/contracts/
COPY services/persona-vault/package.json ./services/persona-vault/
COPY packages/child-discord/package.json ./packages/child-discord/
RUN pnpm install --filter @social-manifold/child-discord... --frozen-lockfile
COPY packages/contracts ./packages/contracts
COPY services/persona-vault ./services/persona-vault
COPY packages/child-discord ./packages/child-discord
RUN pnpm --filter @social-manifold/contracts build
RUN pnpm --filter @social-manifold/persona-vault build
RUN pnpm --filter @social-manifold/child-discord build
RUN pnpm --filter @social-manifold/child-discord deploy --prod /out

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
ENV NODE_ENV=production
# MCP UDS — bound at the canonical path under /run/social-manifold/children/
ENV CHILD_DISCORD_SOCKET_PATH=/run/social-manifold/children/discord.sock
ENV VAULT_SOCKET_PATH=/run/social-manifold/vault.sock
CMD ["node", "dist/server.js"]
