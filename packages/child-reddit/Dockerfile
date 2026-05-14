# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json pnpm-lock.yaml ./
COPY packages/contracts/package.json ./packages/contracts/
COPY services/persona-vault/package.json ./services/persona-vault/
COPY packages/child-reddit/package.json ./packages/child-reddit/
RUN pnpm install --filter @social-manifold/child-reddit... --frozen-lockfile
COPY packages/contracts ./packages/contracts
COPY services/persona-vault ./services/persona-vault
COPY packages/child-reddit ./packages/child-reddit
RUN pnpm --filter @social-manifold/contracts build
RUN pnpm --filter @social-manifold/persona-vault build
RUN pnpm --filter @social-manifold/child-reddit build
RUN pnpm --filter @social-manifold/child-reddit deploy --prod /out

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
ENV NODE_ENV=production
ENV CHILD_REDDIT_SOCKET_PATH=/run/social-manifold/children/reddit.sock
ENV VAULT_SOCKET_PATH=/run/social-manifold/vault.sock
CMD ["node", "dist/server.js"]
