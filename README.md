# Social Manifold

Federated MCP-server stack for cross-platform social engagement. The connective tissue between Tori's Hermes agentic harness and the messy reality of social platforms.

**The operating manual is `CLAUDE.md`** — architecture, persona model, build order, and what we will and will not build live there. Read it before changing anything.

## Quick start

```bash
pnpm install
pnpm test
docker compose build
```

## Layout

- `packages/core` — orchestrator MCP server (intent verbs)
- `packages/child-*` — per-platform child MCPs (added incrementally per CLAUDE.md §15)
- `services/` — supporting services (vault, proxy manager, telemetry, Skyvern)
- `personas/` — per-persona configs (gitignored, sops-encrypted)
- `ops/local/` — runbook for the co-located host (start, stop, persona rotation)
