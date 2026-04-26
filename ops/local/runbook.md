# Local Operations Runbook

Operational notes for running Social Manifold on Patrick's main production host (co-located with Hermes — see CLAUDE.md §7.5).

## Hermes MCP registration (the bridge)

Once the children are running, the core MCP can be exposed to Hermes as a stdio MCP server. Hermes spawns the wrapper script; they speak JSON-RPC over its stdio, and `post_to_community` becomes a callable tool inside the agent.

### Wrapper

`bin/social-manifold-core-mcp` is a self-contained stdio entrypoint. It:
- sets `CORE_IDEMPOTENCY_DB`, `CORE_PERSONAS_ROOT`, `CHILD_DISCORD_SOCKET_PATH`, `CHILD_REDDIT_SOCKET_PATH` to defaults rooted at the repo + canonical `/run/social-manifold/` paths,
- fails fast if `packages/core/dist/server.js` is missing (build wasn't run) or any child socket is absent (services aren't up),
- creates the local `.runtime/` dir for the SQLite ledger,
- `exec`s `node packages/core/dist/server.js` so Hermes' lifecycle controls the process.

Operator overrides any env var by setting it in the Hermes MCP config entry; the wrapper honors what's already set.

### Prerequisite checklist before Hermes attaches

```bash
# 1. one-time per reboot
sudo ./scripts/setup-runtime-dir.sh

# 2. one-time per code change
pnpm install && pnpm -r build

# 3. continuous — the children must be running
docker compose up -d vault child-discord child-reddit
```

### Hermes MCP config snippet

```json
{
  "social-manifold": {
    "command": "/home/rucaradio/tori/social-manifold/bin/social-manifold-core-mcp"
  }
}
```

(Adapt to Hermes' actual config schema — argv form, env-override map, etc. The wrapper accepts no positional args; everything is env.)

After registering and restarting Hermes, the `post_to_community` tool is callable from the agent. The first call materializes the MCP-client-per-child connections; subsequent calls reuse them for the lifetime of the wrapper process (see CLAUDE.md §7.5 — Client lifetime is process-lifetime).

### When the wrapper exits

Hermes will see the MCP go away. The two ways this happens:
- operator restart (intentional)
- one of the child sockets disappeared mid-run (vault/child-discord/child-reddit was stopped). Hermes will respawn the wrapper; the wrapper's startup checks will then fail loudly with the docker-compose hint.

### Smoke test outside Hermes

Before registering with Hermes, you can drive the core directly via the MCP SDK's stdio client to confirm the wrapper boots and the tool is reachable. Run from inside `packages/core/` so node resolves `@modelcontextprotocol/sdk` from that package's `node_modules`:

```bash
cd /home/rucaradio/tori/social-manifold/packages/core
cat > /tmp/smoke.mjs <<'JS'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({
  command: "/home/rucaradio/tori/social-manifold/bin/social-manifold-core-mcp",
});
const c = new Client({ name: "smoke", version: "0.0.1" });
await c.connect(t);
const tools = await c.listTools();
console.log("tools:", tools.tools.map(x => x.name));
await c.close();
JS
node --import "data:text/javascript,import {register} from 'node:module';register('file://' + process.cwd() + '/node_modules/.pnpm/', import.meta.url);" /tmp/smoke.mjs 2>/dev/null || node /tmp/smoke.mjs
```

Or simpler — copy the script into the package and run it there:
```bash
cd /home/rucaradio/tori/social-manifold/packages/core
cat > smoke.mjs <<'JS'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({
  command: "/home/rucaradio/tori/social-manifold/bin/social-manifold-core-mcp",
});
const c = new Client({ name: "smoke", version: "0.0.1" });
await c.connect(t);
console.log("tools:", (await c.listTools()).tools.map(x => x.name));
await c.close();
JS
node smoke.mjs && rm smoke.mjs
```

Expected: `tools: [ 'post_to_community' ]`.

---

## One-time host setup

Required **before** the first `docker compose up`, and again after any host reboot (because `/run` is tmpfs and gets wiped on reboot).

```bash
sudo ./scripts/setup-runtime-dir.sh
```

This:
- Creates `/run/social-manifold/` with mode `0750` and owner `root:social-manifold`.
- Creates `/run/social-manifold/children/` with the same mode/owner — this is where each child MCP binds its UDS (e.g. `discord.sock`).
- Creates the `social-manifold` group if missing.
- Adds the invoking user to the group. **Group membership doesn't take effect in the current shell** — log out and back in, or `newgrp social-manifold`, before continuing.

`docker compose` does **not** create this directory. If it doesn't exist (or the perms drift), the vault and core containers fail fast on startup. That's by design — we'd rather see a loud error at boot than a subtle perms regression.

The script is idempotent: stderr is empty and exit code is 0 on re-runs. Stdout switches from `creating ...` lines on the first run to `... already exists` lines on subsequent runs, plus one `→ mode 0750, owner root:social-manifold` line per run (re-applied unconditionally so perms drift gets corrected if anyone touches the directory by hand).

## Bootstrap a staging persona (one-time per operator)

```bash
pnpm install
pnpm persona:bootstrap-staging
```

Generates `personas/_staging_alpha/.age.key` (mode 0400) and `personas/_staging_alpha/credentials.sops.yaml` (encrypted). Both are gitignored. Re-running the script is idempotent.

Set `AGE_KEY_PATH` in `.env` to point at the generated key (or accept the default in `.env.example`).

## Start the stack

```bash
docker compose up -d
```

Verify:
```bash
ls -l /run/social-manifold/        # vault.sock should appear
curl --unix-socket /run/social-manifold/vault.sock http://localhost/v1/personas
# expected: {"personas":["_staging_alpha"]}
```

## Stop the stack

```bash
docker compose down
```

The vault socket disappears on shutdown. The audit log persists in the `vault_audit` named volume.

## Recovery from host reboot

```bash
sudo ./scripts/setup-runtime-dir.sh    # /run is tmpfs — directory is gone
docker compose up -d
```

## Rate-limit accountant: state lifecycle

Per-persona last-action timestamps live in the core's process memory and clear on restart. After `docker compose restart core`, the very first action per (persona, platform) sees no behavioral throttle — the cadence floor activates from the first action onward.

This is fine for the typical operational pattern (restart, take one un-throttled action, normal cadence resumes). If you're restarting often during a staged rollout AND want strict cadence from the first post, wait `posting_cadence_minutes[0]` after restart before issuing the first verb call.

The idempotency ledger does NOT have this caveat — it's SQLite-backed in the `core_state` volume and survives restarts.

Editing `personas/<id>/identity.yaml` (e.g. changing `posting_cadence_minutes`) requires `docker compose restart core` to pick up — the identity loader caches per-process.

## Reddit OAuth bootstrap (one-time, per persona)

Reddit's OAuth model requires a long-lived `refresh_token` obtained via a one-time user-flow redirect. This is a manual operator step per persona, run once before that persona's reddit platform can be used.

1. Create a Reddit OAuth web app at https://www.reddit.com/prefs/apps. App type: **web app**. Redirect URI: a URL you control (`http://localhost:8080/cb` works for the bootstrap).
2. Note the `client_id` (under the app name) and `client_secret`.
3. From a browser logged into the persona's Reddit account, visit:
   ```
   https://www.reddit.com/api/v1/authorize?client_id=<CLIENT_ID>&response_type=code&state=x&redirect_uri=<REDIRECT_URI>&duration=permanent&scope=identity submit
   ```
4. Approve. Reddit redirects to `<REDIRECT_URI>?code=<CODE>&state=x`.
5. Exchange the code for tokens:
   ```bash
   curl -X POST -u "<CLIENT_ID>:<CLIENT_SECRET>" \
     -d "grant_type=authorization_code&code=<CODE>&redirect_uri=<REDIRECT_URI>" \
     -A "social-manifold/0.0.1" \
     https://www.reddit.com/api/v1/access_token
   ```
6. The response includes `refresh_token`. Add to the persona's encrypted credentials:
   ```yaml
   reddit:
     client_id: <CLIENT_ID>
     client_secret: <CLIENT_SECRET>
     refresh_token: <REFRESH_TOKEN>
   ```
   Re-encrypt with sops.
7. Set `platforms.reddit.enabled: true` in the persona's `identity.yaml`.
8. `docker compose restart core child-reddit`.

### Audit log shift for OAuth-backed children

Reddit (and other OAuth platforms) refresh access_tokens roughly once per hour per persona. The vault's audit log records these refreshes — NOT every verb call. If you see fewer audit entries than verb calls, that's the OAuth child caching its access_token; per-action audit lives at the child level (deferred to the telemetry plan).

### Reddit ban-speed warning

Reddit will ban an unwarmed bot account faster than Discord will. Use a real human-warmed staging account before any production-ish testing. Do NOT use a fresh account.

## Persona rotation

Stub. Persona rotation runbook lands with later plans (when a child MCP first depends on a real persona). For staging, regenerate by deleting the persona dir and re-running `pnpm persona:bootstrap-staging`.

## Log extraction

Audit log:
```bash
docker compose exec vault cat /var/lib/social-manifold/vault-audit.jsonl
```

Container logs:
```bash
docker compose logs vault
docker compose logs core
```
