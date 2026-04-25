import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Alias workspace packages so the integration test can import them by
// canonical name without core needing to declare a runtime/dev dep on them.
// Build deps with `pnpm -r build` before running tests.
const repoRoot = resolve(__dirname, "../..");

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    alias: {
      "@social-manifold/persona-vault/client": resolve(
        repoRoot,
        "services/persona-vault/dist/client/index.js",
      ),
      "@social-manifold/persona-vault": resolve(
        repoRoot,
        "services/persona-vault/dist/server.js",
      ),
      "@social-manifold/child-discord/dist/server.js": resolve(
        repoRoot,
        "packages/child-discord/dist/server.js",
      ),
      "@social-manifold/child-discord/dist/deps.js": resolve(
        repoRoot,
        "packages/child-discord/dist/deps.js",
      ),
    },
  },
});
