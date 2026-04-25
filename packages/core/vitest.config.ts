import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Alias workspace packages so the integration test can import them by
// canonical name without core needing to declare a runtime/dev dep on them.
// We can't add @social-manifold/persona-vault or @social-manifold/child-discord
// to core's deps (runtime or dev) because pnpm deploy --prod validates the
// full workspace dep graph at deploy time, and any path that requires those
// packages to be resolvable inside core's deploy artifact breaks the build.
// Aliasing here keeps the test's import sugar without polluting core's
// production graph. Build deps with `pnpm -r build` before running tests.
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
