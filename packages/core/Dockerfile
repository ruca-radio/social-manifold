# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
RUN pnpm install --filter @social-manifold/core... --frozen-lockfile
COPY packages/core ./packages/core
RUN pnpm --filter @social-manifold/core build
RUN pnpm --filter @social-manifold/core deploy --prod /out

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
ENV NODE_ENV=production
CMD ["node", "dist/server.js"]
