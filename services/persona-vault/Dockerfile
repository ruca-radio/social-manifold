# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json pnpm-lock.yaml ./
COPY services/persona-vault/package.json ./services/persona-vault/
RUN pnpm install --filter @social-manifold/persona-vault... --frozen-lockfile
COPY services/persona-vault ./services/persona-vault
RUN pnpm --filter @social-manifold/persona-vault build
RUN pnpm --filter @social-manifold/persona-vault deploy --prod /out

FROM node:20-alpine AS runtime
RUN apk add --no-cache sops age
WORKDIR /app
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
ENV NODE_ENV=production
ENV VAULT_PERSONAS_ROOT=/var/social-manifold/personas
ENV VAULT_AUDIT_PATH=/var/lib/social-manifold/vault-audit.jsonl
ENV VAULT_SOCKET_PATH=/run/social-manifold/vault.sock
# SOPS_AGE_KEY_FILE is set by the operator at runtime; the file is bind-mounted
# read-only from the host. NEVER bake an age key into the image.
ENV SOPS_AGE_KEY_FILE=/etc/social-manifold/age.key
CMD ["node", "dist/server.js"]
