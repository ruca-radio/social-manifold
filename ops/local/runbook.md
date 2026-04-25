# Local Operations Runbook

Operational notes for running Social Manifold on Patrick's main production host (co-located with Hermes — see CLAUDE.md §7.5).

## One-time host setup

Required **before** the first `docker compose up`, and again after any host reboot (because `/run` is tmpfs and gets wiped on reboot).

```bash
sudo ./scripts/setup-runtime-dir.sh
```

This:
- Creates `/run/social-manifold/` with mode `0750` and owner `root:social-manifold`.
- Creates the `social-manifold` group if missing.
- Adds the invoking user to the group. **Group membership doesn't take effect in the current shell** — log out and back in, or `newgrp social-manifold`, before continuing.

`docker compose` does **not** create this directory. If it doesn't exist (or the perms drift), the vault and core containers fail fast on startup. That's by design — we'd rather see a loud error at boot than a subtle perms regression.

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
