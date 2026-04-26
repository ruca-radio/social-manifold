# Idempotency Ledger + Rate-Limit Accountant — Plan 4

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two operational gates that sit between Hermes verb calls and child-MCP execution: (a) an idempotency ledger that makes safe-by-default retries free, and (b) a two-layer rate-limit accountant that enforces both platform-published limits and per-persona behavioral limits before any verb reaches a child.

**Architecture:** Both gates live in the core, in front of the verb routing layer. Idempotency uses `better-sqlite3` (file-backed, durable across restarts, lazy TTL). The rate-limit accountant is in-process with a clean port interface — easy to extract to its own service later if multi-instance core ever materializes. Per-persona behavioral state is in-memory (restart-clears; documented). Children surface platform-observed rate limits (Discord 429, etc.) back to core via an extension to the `VerbResult` contract; core records these in the accountant for future backoff decisions.

```
HERMES → core MCP (post_to_community)
            │
            ▼
         idempotency ledger lookup ─┐
            │ miss                  │ hit → return prior VerbResult (status: "deduped")
            ▼                       │
         rate-limit accountant ─────┤
            │ allow                 │ deny → return failed (warning: retry_after_seconds=N)
            ▼                       │
         child MCP call             │
            │                       │
            ▼                       │
         VerbResult ────────────────┴─ if platform_rate_limit set → record backoff
            │ also: ledger.record(key, result)
            ▼
         response to Hermes
```

**Tech Stack:** Node 20, TypeScript 5, `better-sqlite3` (file-backed, sync), `js-yaml` (already a workspace dep) for identity loading, Vitest. No new transports or services.

**Scope (covers §15 step 4 only):** ledger + accountant + the wire-up. Telemetry/OTel deferred to Plan 6. Persisting accountant state to SQLite deferred. Multi-credential per platform deferred (we have one persona per platform now). Per-persona accountant state across restarts deferred.

---

## CLAUDE.md amendments required (flagged per project_persona_decisions.md and feedback_claude_md_amendments.md)

Both amendments land as part of this plan, in a single commit, before any task that depends on them.

### Amendment A — §4 VerbResult contract extension

Current text (CLAUDE.md line 143):
> Every verb returns a `VerbResult` with `{status, platform_response_id, idempotency_key, telemetry_span_id, warnings[]}`.

Replace with:
> Every verb returns a `VerbResult` with `{status, platform_response_id, idempotency_key, telemetry_span_id, warnings[]}` plus optional extension fields. Children may set `platform_rate_limit: { retry_after_seconds: number }` when the underlying platform returns a rate-limit signal (e.g. Discord 429); the core's rate-limit accountant uses this to record backoff. Other optional extensions are added as needed; readers must treat unknown fields as opaque.

Why: the rate-limit accountant needs structured (not free-text) signal back from children to incorporate platform 429s. A free-text warning would be fragile to parse. Open contract extension is the cleaner pattern; `warnings[]` stays for advisory-only messages.

### Amendment B — §9 rate-limit enforcement point

Current text (CLAUDE.md line 479):
> The persona limit is the binding constraint. Children query the rate-limit accountant before every action and back off if the persona isn't due.

Replace with:
> The persona limit is the binding constraint. **The core enforces both layers before forwarding any call to a child** — children never see a rate-limited request. Children surface platform-observed rate limits (e.g. Discord 429) back to the core via `VerbResult.platform_rate_limit` (see §4); the core's accountant records these to inform future per-persona backoff decisions. The two-way model: core gates outbound calls; children report observed pushback inbound.

Why: child MCPs shouldn't need to know per-persona cadence policy — that's an operator-level concern owned by the manifold. Putting enforcement in core also keeps the accountant authoritative; otherwise multiple children would hold inconsistent views. Patrick clarified this in the Plan 4 brief; the original §9 wording reflected a different design.

---

## Decisions surfaced

### D1. Idempotency ledger storage: `better-sqlite3` (file-backed)

Per CLAUDE.md §9. `better-sqlite3` over `node:sqlite` (the new built-in) because: (a) sync API matches the lookup pattern (one query per verb call, on the request path — async would add overhead with no concurrency win), (b) prepared statements are first-class, (c) transactional support for the record path. Single file at `/var/lib/social-manifold/idempotency.db` inside the core container, persisted in a named volume.

### D2. TTL enforcement: lazy

On `lookup(key)`: if the row exists but `created_at < now - 7 days`, delete the row in the same SQL statement and treat as miss. No background sweeper for v1. Reasoning: the request path already touches the row; the marginal cost of one DELETE on a stale hit is trivial. A sweeper adds operational surface (when does it run? what if it's behind?) for negligible benefit at our scale. Document the trade-off (the table can grow unboundedly between lookups for keys never re-queried — bounded growth in practice because most verb calls are unique-keyed retries within a few minutes).

### D3. Rate-limit accountant scope: in-process within core

In-process for v1, with the public surface kept narrow (`checkAndReserve`, `recordPlatformBackoff`, `recordSuccessfulCall`) and free of `process`/`fs`/`new SQLiteDB` references inside the accountant module. If multi-instance core ever lands, the accountant becomes a separate service via the same interface; the wire format would be MCP or HTTP-RPC at that point. Not bending CLAUDE.md §2 — the accountant isn't a child MCP, it's an internal core component, like the ledger.

### D4. Per-persona behavioral enforcement: core (pre-routing); children surface platform 429s back

The two-way model from Amendment B. Core's check happens BEFORE forwarding to the child; if denied, no child call. The child only sees calls that have already passed the gate. Inbound: when the child observes a platform-level rate limit (Discord 429 with `retry_after`), it sets `VerbResult.platform_rate_limit.retry_after_seconds` and the core's accountant records it as a backoff, applied to future `checkAndReserve` decisions for that (persona, platform).

This means rate-limiter state is updated by both outbound calls AND inbound 429 reports. The accountant has two write paths and one read path. Documented in the accountant's interface comments.

### D5. Per-persona accountant state: in-memory; restart clears

Per-persona last-action timestamps live in a `Map<string, { last_action_ts: number, backoff_until?: number }>` keyed by `${persona_id}:${platform}`. Restart clears the map — the operator accepts that the very first action after a restart sees no behavioral throttle. Trade-off vs. persisting to SQLite: simpler code path, no second migration story, and the restart-clear behavior is bounded (one un-throttled action per persona per restart). For v1 this is fine. Documented in `ops/local/runbook.md` as a known characteristic.

If this becomes operationally annoying (e.g., frequent core restarts during staged rollouts), persisting the timestamps to the same SQLite file as the ledger is the natural next step — same connection, separate table, no new dependencies.

### D6. Identity loading: core reads `personas/<id>/identity.yaml` directly

The accountant needs `posting_cadence_minutes` to compute the per-persona limit. Two options:
- (a) New vault endpoint `GET /v1/personas/:id/identity` — vault-mediated, but vault is supposed to be for *secrets* and identity has no secrets.
- (b) Core mounts `./personas:ro` and reads identity.yaml directly via a small loader.

(b) is simpler, doesn't widen the vault's surface, and the persona dir is already public-ish (committed for `_staging_alpha`). The compose mount adds one line. Picking (b).

The loader is in-process and caches identities for the life of the core process; `posting_cadence_minutes` rarely changes operationally, and the operator can `docker compose restart core` to pick up edits (documented).

### D7. Idempotency key as the dedup unit

A verb call is "the same call" iff its `idempotency_key` matches a prior call's. This is intentional — the caller (Hermes or operator) is responsible for choosing keys that capture intent (e.g., one key per "post to /r/foo at scheduled time T", regenerated only if the operator wants a new post). Two distinct user intents with the same content text MUST get different keys.

Generated keys (UUIDs from `randomUUID()` when the caller doesn't provide one) make every auto-keyed call unique by construction — they will never dedup. That's the right default: an unkeyed verb call from a smart caller (Hermes) means "do this fresh"; only explicit keys deduplicate.

### D8. Ledger record shape and what counts as "the same response"

The ledger row stores `{ idempotency_key, persona_id, verb, status, platform_response_id, response_blob, created_at }`. `response_blob` is the JSON-serialized full `VerbResult`. On a hit, the lookup returns that blob, `status` becomes `"deduped"`, and `warnings` gets a note like `"deduped from 2026-04-25T19:34:02Z"` for operator visibility. Other fields including `platform_response_id` are returned as originally recorded.

We record EVERY verb result, not just successes. A failed verb retried with the same key returns the failure — this is correct; the retry doesn't help if the underlying problem is the same. If the operator wants to retry-after-fix, they regenerate the key.

---

## File structure

```
packages/core/
├── package.json                         ← MODIFIED — add better-sqlite3, js-yaml
├── src/
│   ├── idempotency/
│   │   ├── schema.ts                    ← NEW — SQL DDL
│   │   └── ledger.ts                    ← NEW — sync API, lazy TTL
│   ├── ratelimit/
│   │   ├── accountant.ts                ← NEW — in-process two-layer
│   │   └── identity-loader.ts           ← NEW — reads identity.yaml from personas root
│   ├── verbs/
│   │   └── post_to_community.ts         ← MODIFIED — wire dedupe + ratelimit
│   ├── server.ts                        ← MODIFIED — instantiate ledger + accountant
│   └── child-clients/discord.ts         ← unchanged
└── tests/
    ├── ledger.test.ts                   ← NEW
    ├── accountant.test.ts               ← NEW
    ├── identity-loader.test.ts          ← NEW
    ├── post_to_community.test.ts        ← MODIFIED — add dedup + ratelimit cases
    ├── integration.test.ts              ← MODIFIED — add e2e dedup proof
    └── server.test.ts                   ← MODIFIED — pass ledger + accountant deps

packages/contracts/src/
└── verbs.ts                             ← MODIFIED — add platform_rate_limit field

packages/child-discord/src/
├── adapter.ts                           ← MODIFIED — detect Discord 429
└── mcp-server.ts                        ← MODIFIED — pass through 429 info

ops/local/runbook.md                     ← MODIFIED — note restart-clear behavior
docker-compose.yml                       ← MODIFIED — SQLite volume + personas mount on core
CLAUDE.md                                ← MODIFIED — Amendments A and B
```

---

### Task 1: CLAUDE.md amendments (must land first)

**Files:**
- Modify: `CLAUDE.md` (Amendments A and B above)
- Modify: `packages/contracts/src/verbs.ts` — add the optional field

- [ ] **Step 1: Apply Amendment A to CLAUDE.md §4**

Find the line `Every verb returns a \`VerbResult\` with {status, platform_response_id, idempotency_key, telemetry_span_id, warnings[]}.` and replace with the Amendment A text above.

- [ ] **Step 2: Apply Amendment B to CLAUDE.md §9**

Find the line `The persona limit is the binding constraint. Children query the rate-limit accountant before every action and back off if the persona isn't due.` and replace with the Amendment B text above.

- [ ] **Step 3: Extend `packages/contracts/src/verbs.ts`**

```typescript
export type VerbStatus = "ok" | "echoed" | "deduped" | "failed";

export interface VerbResult {
  status: VerbStatus;
  platform_response_id: string | null;
  idempotency_key: string;
  telemetry_span_id: string | null;
  warnings: string[];
  /**
   * Set by a child when the platform returned a rate-limit signal
   * (e.g. Discord 429 with Retry-After). The core's rate-limit accountant
   * uses this to record backoff for future calls. See CLAUDE.md §4 + §9.
   */
  platform_rate_limit?: { retry_after_seconds: number };
}

export interface MediaRef {
  kind: "image" | "video" | "link";
  url: string;
  alt_text?: string;
}

export interface PostToCommunityInput {
  persona_id: string;
  community_ref: string;
  content: string;
  media?: MediaRef[];
  idempotency_key?: string;
}
```

- [ ] **Step 4: Build contracts to confirm clean**

Run: `pnpm --filter @social-manifold/contracts build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md packages/contracts/src/verbs.ts
git commit -m "docs(claude): extend VerbResult contract; clarify rate-limit enforcement is in core"
```

---

### Task 2: Idempotency ledger (TDD)

**Files:**
- Create: `packages/core/src/idempotency/schema.ts`
- Create: `packages/core/src/idempotency/ledger.ts`
- Create: `packages/core/tests/ledger.test.ts`
- Modify: `packages/core/package.json` (add `better-sqlite3`)

- [ ] **Step 1: Add `better-sqlite3` to core**

Edit `packages/core/package.json` — add to `dependencies`:
```json
"better-sqlite3": "^11.5.0"
```
And to `devDependencies`:
```json
"@types/better-sqlite3": "^7.6.12"
```

Run: `pnpm install`. Expected: better-sqlite3 native build succeeds (it has a native compile step; alpine in Docker may need a build-essentials layer — see Task 8).

- [ ] **Step 2: Write the failing test**

Path: `packages/core/tests/ledger.test.ts`
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdempotencyLedger } from "../src/idempotency/ledger.js";
import type { VerbResult } from "@social-manifold/contracts";

const SAMPLE: VerbResult = {
  status: "ok",
  platform_response_id: "msg-1",
  idempotency_key: "k1",
  telemetry_span_id: null,
  warnings: [],
};

describe("IdempotencyLedger", () => {
  let dir: string;
  let ledger: IdempotencyLedger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-"));
    ledger = new IdempotencyLedger(join(dir, "idem.db"));
  });

  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null on lookup of an unknown key", () => {
    expect(ledger.lookup("nope")).toBeNull();
  });

  it("stores and returns a VerbResult by key", () => {
    ledger.record("k1", "p1", "post_to_community", SAMPLE);
    const got = ledger.lookup("k1");
    expect(got).not.toBeNull();
    expect(got!.status).toBe("deduped");
    expect(got!.platform_response_id).toBe("msg-1");
    expect(got!.idempotency_key).toBe("k1");
    // dedup hit must annotate warnings with a hint
    expect(got!.warnings.some((w) => w.includes("deduped from"))).toBe(true);
  });

  it("preserves all original fields on a hit (other than status/warnings)", () => {
    const richResult: VerbResult = {
      status: "ok",
      platform_response_id: "msg-2",
      idempotency_key: "k2",
      telemetry_span_id: "span-abc",
      warnings: ["original-warning"],
      platform_rate_limit: { retry_after_seconds: 3 },
    };
    ledger.record("k2", "p1", "post_to_community", richResult);
    const got = ledger.lookup("k2");
    expect(got!.platform_response_id).toBe("msg-2");
    expect(got!.telemetry_span_id).toBe("span-abc");
    expect(got!.platform_rate_limit?.retry_after_seconds).toBe(3);
  });

  it("records and dedups failed results too (no retry-of-failure auto-recovery)", () => {
    const failed: VerbResult = {
      status: "failed",
      platform_response_id: null,
      idempotency_key: "k-fail",
      telemetry_span_id: null,
      warnings: ["original failure reason"],
    };
    ledger.record("k-fail", "p1", "post_to_community", failed);
    const got = ledger.lookup("k-fail");
    expect(got!.status).toBe("deduped");
    expect(
      got!.warnings.some((w) => w.includes("original failure reason")),
    ).toBe(true);
  });

  it("lazy-expires entries past the TTL on lookup", () => {
    const ageingLedger = new IdempotencyLedger(join(dir, "idem2.db"), {
      ttlMs: 10,
    });
    ageingLedger.record("k-old", "p1", "post_to_community", SAMPLE);
    expect(ageingLedger.lookup("k-old")).not.toBeNull();
    // wait past TTL
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(ageingLedger.lookup("k-old")).toBeNull();
        // and the row is deleted, not just hidden
        expect(ageingLedger.size()).toBe(0);
        ageingLedger.close();
        resolve();
      }, 20);
    });
  });

  it("uniqueness on idempotency_key — re-recording with same key replaces", () => {
    ledger.record("k1", "p1", "post_to_community", SAMPLE);
    const second: VerbResult = {
      ...SAMPLE,
      platform_response_id: "msg-replaced",
    };
    ledger.record("k1", "p1", "post_to_community", second);
    expect(ledger.lookup("k1")!.platform_response_id).toBe("msg-replaced");
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/core test -- ledger`
Expected: module not found.

- [ ] **Step 4: Implement `packages/core/src/idempotency/schema.ts`**

```typescript
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency (
  idempotency_key TEXT PRIMARY KEY,
  persona_id      TEXT NOT NULL,
  verb            TEXT NOT NULL,
  response_blob   TEXT NOT NULL,
  created_at_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created_at
  ON idempotency(created_at_ms);
`;
```

- [ ] **Step 5: Implement `packages/core/src/idempotency/ledger.ts`**

```typescript
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import type { VerbResult } from "@social-manifold/contracts";
import { SCHEMA } from "./schema.js";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LedgerOptions {
  ttlMs?: number;
}

/**
 * Idempotency ledger backed by SQLite (better-sqlite3, sync API).
 * TTL is enforced lazily on lookup — see CLAUDE.md §9.
 */
export class IdempotencyLedger {
  #db: DB;
  #ttlMs: number;
  #stmtLookup;
  #stmtRecord;
  #stmtDelete;
  #stmtCount;

  constructor(filePath: string, opts: LedgerOptions = {}) {
    this.#db = new Database(filePath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.exec(SCHEMA);
    this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

    this.#stmtLookup = this.#db.prepare<
      [string],
      { response_blob: string; created_at_ms: number }
    >(
      "SELECT response_blob, created_at_ms FROM idempotency WHERE idempotency_key = ?",
    );
    this.#stmtRecord = this.#db.prepare(
      `INSERT INTO idempotency (idempotency_key, persona_id, verb, response_blob, created_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         persona_id = excluded.persona_id,
         verb = excluded.verb,
         response_blob = excluded.response_blob,
         created_at_ms = excluded.created_at_ms`,
    );
    this.#stmtDelete = this.#db.prepare(
      "DELETE FROM idempotency WHERE idempotency_key = ?",
    );
    this.#stmtCount = this.#db.prepare<[], { c: number }>(
      "SELECT COUNT(*) AS c FROM idempotency",
    );
  }

  lookup(key: string): VerbResult | null {
    const row = this.#stmtLookup.get(key);
    if (!row) return null;
    const ageMs = Date.now() - row.created_at_ms;
    if (ageMs > this.#ttlMs) {
      this.#stmtDelete.run(key);
      return null;
    }
    const original = JSON.parse(row.response_blob) as VerbResult;
    const at = new Date(row.created_at_ms).toISOString();
    return {
      ...original,
      status: "deduped",
      warnings: [
        `deduped from ${at}`,
        ...(original.warnings ?? []),
      ],
    };
  }

  record(
    key: string,
    personaId: string,
    verb: string,
    result: VerbResult,
  ): void {
    this.#stmtRecord.run(
      key,
      personaId,
      verb,
      JSON.stringify(result),
      Date.now(),
    );
  }

  size(): number {
    return this.#stmtCount.get()?.c ?? 0;
  }

  close(): void {
    this.#db.close();
  }
}
```

- [ ] **Step 6: Run, expect PASS**

Run: `pnpm --filter @social-manifold/core test -- ledger`
Expected: 6 ledger tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/package.json packages/core/src/idempotency packages/core/tests/ledger.test.ts pnpm-lock.yaml
git commit -m "feat(core): add SQLite-backed idempotency ledger with lazy TTL"
```

---

### Task 3: Identity loader (TDD)

The accountant needs `posting_cadence_minutes` from each persona's identity.yaml. Small loader, in-process cache.

**Files:**
- Create: `packages/core/src/ratelimit/identity-loader.ts`
- Create: `packages/core/tests/identity-loader.test.ts`
- Modify: `packages/core/package.json` — add `js-yaml` + types

- [ ] **Step 1: Add js-yaml**

Edit `packages/core/package.json` — add to `dependencies`:
```json
"js-yaml": "^4.1.0"
```
And to `devDependencies`:
```json
"@types/js-yaml": "^4.0.9"
```

Run: `pnpm install`.

- [ ] **Step 2: Write the failing test**

Path: `packages/core/tests/identity-loader.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityLoader } from "../src/ratelimit/identity-loader.js";

const IDENTITY = `id: p_alpha
display_name: "p_alpha"
type: branded_bot
timezone: UTC
locale: en-US
working_hours: "00:00-23:59"
posting_cadence_minutes: [12, 45]
proxy_pool: none
disclosed_automation: true
platforms:
  discord:
    enabled: true
`;

async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "id-loader-"));
  await mkdir(join(root, "p_alpha"), { recursive: true });
  await writeFile(join(root, "p_alpha", "identity.yaml"), IDENTITY, "utf8");
  return root;
}

describe("IdentityLoader", () => {
  it("loads posting_cadence_minutes for a persona", async () => {
    const root = await setup();
    const loader = new IdentityLoader(root);
    const cadence = await loader.cadenceMinutes("p_alpha");
    expect(cadence).toEqual([12, 45]);
  });

  it("caches identities — second load does not re-read disk", async () => {
    const root = await setup();
    const loader = new IdentityLoader(root);
    await loader.cadenceMinutes("p_alpha");
    // mutate the file underneath; cached loader should NOT pick it up
    await writeFile(
      join(root, "p_alpha", "identity.yaml"),
      IDENTITY.replace("[12, 45]", "[99, 999]"),
      "utf8",
    );
    const cadence = await loader.cadenceMinutes("p_alpha");
    expect(cadence).toEqual([12, 45]);
  });

  it("throws on unknown persona", async () => {
    const root = await setup();
    const loader = new IdentityLoader(root);
    await expect(loader.cadenceMinutes("ghost")).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/core test -- identity-loader`
Expected: module not found.

- [ ] **Step 4: Implement**

Path: `packages/core/src/ratelimit/identity-loader.ts`
```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

interface Identity {
  id: string;
  posting_cadence_minutes: [number, number];
}

/**
 * Reads identity.yaml from a personas root directory and caches each
 * persona's identity in memory for the life of the process. Operator can
 * `docker compose restart core` to pick up edits — documented in
 * ops/local/runbook.md.
 */
export class IdentityLoader {
  #cache = new Map<string, Identity>();

  constructor(private readonly personasRoot: string) {}

  async cadenceMinutes(personaId: string): Promise<[number, number]> {
    const id = await this.#load(personaId);
    return id.posting_cadence_minutes;
  }

  async #load(personaId: string): Promise<Identity> {
    const cached = this.#cache.get(personaId);
    if (cached) return cached;
    const path = join(this.personasRoot, personaId, "identity.yaml");
    const raw = await readFile(path, "utf8");
    const parsed = yaml.load(raw) as Identity;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.posting_cadence_minutes) ||
      parsed.posting_cadence_minutes.length !== 2
    ) {
      throw new Error(
        `identity.yaml for ${personaId} is missing valid posting_cadence_minutes`,
      );
    }
    this.#cache.set(personaId, parsed);
    return parsed;
  }
}
```

- [ ] **Step 5: Run, expect PASS**

Run: `pnpm --filter @social-manifold/core test -- identity-loader`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json packages/core/src/ratelimit/identity-loader.ts packages/core/tests/identity-loader.test.ts pnpm-lock.yaml
git commit -m "feat(core): add identity loader for per-persona cadence config"
```

---

### Task 4: Rate-limit accountant (TDD)

**Files:**
- Create: `packages/core/src/ratelimit/accountant.ts`
- Create: `packages/core/tests/accountant.test.ts`

The accountant has three public methods:
- `checkAndReserve(personaId, platform, now): { allowed: boolean; retry_after_seconds?: number }` — reserves a slot (records `last_action_ts = now`) if allowed; otherwise returns the wait time without reserving.
- `recordPlatformBackoff(personaId, platform, retry_after_seconds, now): void` — sets `backoff_until = now + retry_after_ms`.
- `recordSuccessfulCall(personaId, platform, now): void` — records `last_action_ts = now`. Used after a successful child call (separate from `checkAndReserve` so we can choose to record-after-confirm rather than record-on-reserve; see test).

The cadence is read from `IdentityLoader` injected at construction. Min minute determines the throttle floor; max is informational for now (used by future jitter logic in persona warmup, Plan 13).

- [ ] **Step 1: Write the failing test**

Path: `packages/core/tests/accountant.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { RateLimitAccountant } from "../src/ratelimit/accountant.js";

interface FakeLoader {
  cadenceMinutes(personaId: string): Promise<[number, number]>;
}

const loader = (cadence: [number, number]): FakeLoader => ({
  async cadenceMinutes() {
    return cadence;
  },
});

describe("RateLimitAccountant", () => {
  it("first call for a persona is allowed", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const r = await acc.checkAndReserve("p1", "discord", 1_000_000);
    expect(r.allowed).toBe(true);
  });

  it("a second call within the persona min cadence is denied with retry_after", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const t0 = 1_000_000;
    const ok = await acc.checkAndReserve("p1", "discord", t0);
    expect(ok.allowed).toBe(true);
    // 5 minutes later — well below the 10-minute floor
    const denied = await acc.checkAndReserve("p1", "discord", t0 + 5 * 60_000);
    expect(denied.allowed).toBe(false);
    expect(denied.retry_after_seconds).toBeGreaterThan(0);
    expect(denied.retry_after_seconds).toBeLessThanOrEqual(300);
  });

  it("a second call past the persona min cadence is allowed", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const t0 = 1_000_000;
    await acc.checkAndReserve("p1", "discord", t0);
    const r = await acc.checkAndReserve("p1", "discord", t0 + 11 * 60_000);
    expect(r.allowed).toBe(true);
  });

  it("denied calls do NOT consume the slot — third call still has accurate retry_after", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const t0 = 1_000_000;
    await acc.checkAndReserve("p1", "discord", t0);
    await acc.checkAndReserve("p1", "discord", t0 + 1_000); // denied
    const third = await acc.checkAndReserve("p1", "discord", t0 + 2_000);
    // third call: still about 10 minutes from t0, NOT 10 minutes from the most recent denied probe
    expect(third.allowed).toBe(false);
    expect(third.retry_after_seconds).toBeGreaterThan(595);
  });

  it("recordPlatformBackoff sets a backoff that beats the cadence floor", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const t0 = 1_000_000;
    await acc.checkAndReserve("p1", "discord", t0);
    // platform says wait 30 minutes
    acc.recordPlatformBackoff("p1", "discord", 30 * 60, t0);
    // 11 minutes later — past cadence floor, but still inside platform backoff
    const r = await acc.checkAndReserve("p1", "discord", t0 + 11 * 60_000);
    expect(r.allowed).toBe(false);
    expect(r.retry_after_seconds).toBeGreaterThan(60 * 18);
  });

  it("after backoff expires AND cadence floor is past, the next call is allowed", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const t0 = 1_000_000;
    await acc.checkAndReserve("p1", "discord", t0);
    acc.recordPlatformBackoff("p1", "discord", 30 * 60, t0);
    const r = await acc.checkAndReserve("p1", "discord", t0 + 31 * 60_000);
    expect(r.allowed).toBe(true);
  });

  it("isolates state by (persona_id, platform)", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const t0 = 1_000_000;
    await acc.checkAndReserve("p1", "discord", t0);
    // different persona, same platform — independent
    const a = await acc.checkAndReserve("p2", "discord", t0);
    expect(a.allowed).toBe(true);
    // same persona, different platform — independent
    const b = await acc.checkAndReserve("p1", "reddit", t0);
    expect(b.allowed).toBe(true);
  });

  it("recordSuccessfulCall is idempotent at the same instant (defensive)", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const t0 = 1_000_000;
    await acc.checkAndReserve("p1", "discord", t0);
    acc.recordSuccessfulCall("p1", "discord", t0); // already reserved at t0
    const r = await acc.checkAndReserve("p1", "discord", t0 + 11 * 60_000);
    expect(r.allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/core test -- accountant`
Expected: module not found.

- [ ] **Step 3: Implement**

Path: `packages/core/src/ratelimit/accountant.ts`
```typescript
export interface CadenceLoader {
  cadenceMinutes(personaId: string): Promise<[number, number]>;
}

export interface CheckResult {
  allowed: boolean;
  retry_after_seconds?: number;
}

interface State {
  last_action_ts_ms?: number;
  backoff_until_ms?: number;
}

/**
 * Two-layer in-process rate-limit accountant.
 *
 *   Layer 1: per-persona behavioral floor — `posting_cadence_minutes[0]` from
 *            identity.yaml. The persona must wait at least that many minutes
 *            between actions on a given platform.
 *   Layer 2: platform-observed backoff — when a child reports
 *            `VerbResult.platform_rate_limit`, we record `backoff_until = now
 *            + retry_after`. Future checkAndReserve calls are denied until
 *            both that time AND the cadence floor are past.
 *
 * State is held in memory keyed by `${persona_id}:${platform}`. Restart
 * clears state — see Plan 4 D5 + ops/local/runbook.md.
 *
 * Public surface is intentionally narrow so this can be extracted to a
 * separate service later (Plan 4 D3) without source changes at the call
 * site beyond the import.
 */
export class RateLimitAccountant {
  #state = new Map<string, State>();

  constructor(private readonly identity: CadenceLoader) {}

  async checkAndReserve(
    personaId: string,
    platform: string,
    nowMs: number,
  ): Promise<CheckResult> {
    const key = this.#k(personaId, platform);
    const s = this.#state.get(key) ?? {};
    const cadence = await this.identity.cadenceMinutes(personaId);
    const floorMs = cadence[0] * 60_000;

    const cadenceReadyAt =
      s.last_action_ts_ms !== undefined ? s.last_action_ts_ms + floorMs : 0;
    const backoffReadyAt = s.backoff_until_ms ?? 0;
    const readyAt = Math.max(cadenceReadyAt, backoffReadyAt);

    if (nowMs >= readyAt) {
      this.#state.set(key, { ...s, last_action_ts_ms: nowMs });
      return { allowed: true };
    }
    return {
      allowed: false,
      retry_after_seconds: Math.ceil((readyAt - nowMs) / 1000),
    };
  }

  recordPlatformBackoff(
    personaId: string,
    platform: string,
    retryAfterSeconds: number,
    nowMs: number,
  ): void {
    const key = this.#k(personaId, platform);
    const s = this.#state.get(key) ?? {};
    this.#state.set(key, {
      ...s,
      backoff_until_ms: nowMs + retryAfterSeconds * 1000,
    });
  }

  recordSuccessfulCall(
    personaId: string,
    platform: string,
    nowMs: number,
  ): void {
    const key = this.#k(personaId, platform);
    const s = this.#state.get(key) ?? {};
    // Only advance, never go backwards in time
    if (s.last_action_ts_ms === undefined || nowMs > s.last_action_ts_ms) {
      this.#state.set(key, { ...s, last_action_ts_ms: nowMs });
    }
  }

  #k(personaId: string, platform: string): string {
    return `${personaId}:${platform}`;
  }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @social-manifold/core test -- accountant`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ratelimit/accountant.ts packages/core/tests/accountant.test.ts
git commit -m "feat(core): add in-process rate-limit accountant with two-layer model"
```

---

### Task 5: Wire into post_to_community (TDD)

The verb's flow becomes: idempotency lookup → rate-limit check → child call → record platform backoff (if any) → record in ledger → return.

**Files:**
- Modify: `packages/core/src/verbs/post_to_community.ts`
- Modify: `packages/core/tests/post_to_community.test.ts`
- Modify: `packages/core/src/server.ts`
- Modify: `packages/core/tests/server.test.ts`

- [ ] **Step 1: Update test fixtures with the new dep shape**

Path: `packages/core/tests/post_to_community.test.ts` — replace contents with:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postToCommunity } from "../src/verbs/post_to_community.js";
import { IdempotencyLedger } from "../src/idempotency/ledger.js";
import {
  RateLimitAccountant,
  type CadenceLoader,
} from "../src/ratelimit/accountant.js";
import type { DiscordChildClient } from "../src/child-clients/discord.js";
import type { VerbResult } from "@social-manifold/contracts";

const cadence = (mins: [number, number]): CadenceLoader => ({
  async cadenceMinutes() {
    return mins;
  },
});

interface CallSpy {
  calls: Array<Record<string, unknown>>;
  result?: VerbResult;
  throws?: Error;
}

function fakeDiscord(spy: CallSpy): DiscordChildClient {
  return {
    postToCommunity: async (input: Record<string, unknown>) => {
      spy.calls.push(input);
      if (spy.throws) throw spy.throws;
      return (
        spy.result ?? {
          status: "ok",
          platform_response_id: "msg-1",
          idempotency_key: input.idempotency_key as string,
          telemetry_span_id: null,
          warnings: [],
        }
      );
    },
  } as unknown as DiscordChildClient;
}

describe("postToCommunity (with ledger + accountant)", () => {
  let dir: string;
  let ledger: IdempotencyLedger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "p2c-"));
    ledger = new IdempotencyLedger(join(dir, "idem.db"));
    return () => {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    };
  });

  it("forwards a fresh discord:// call to the child and records in ledger", async () => {
    const spy: CallSpy = { calls: [] };
    const acc = new RateLimitAccountant(cadence([0, 0])); // no throttle
    const result = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "hi",
        idempotency_key: "k1",
      },
      { discord: fakeDiscord(spy), ledger, accountant: acc, now: () => 0 },
    );
    expect(result.status).toBe("ok");
    expect(spy.calls).toHaveLength(1);
    // ledger stored it
    expect(ledger.lookup("k1")?.status).toBe("deduped");
  });

  it("returns deduped on a second call with the same key — child NOT called again", async () => {
    const spy: CallSpy = { calls: [] };
    const acc = new RateLimitAccountant(cadence([0, 0]));
    const args = {
      persona_id: "p1",
      community_ref: "discord://guild:111/channel:222",
      content: "hi",
      idempotency_key: "k-dup",
    };
    const a = await postToCommunity(args, {
      discord: fakeDiscord(spy),
      ledger,
      accountant: acc,
      now: () => 0,
    });
    const b = await postToCommunity(args, {
      discord: fakeDiscord(spy),
      ledger,
      accountant: acc,
      now: () => 1000,
    });
    expect(a.status).toBe("ok");
    expect(b.status).toBe("deduped");
    expect(spy.calls).toHaveLength(1); // child only called the first time
    expect(b.platform_response_id).toBe(a.platform_response_id);
    expect(b.warnings.some((w) => w.includes("deduped from"))).toBe(true);
  });

  it("returns failed with retry_after when persona is rate-limited", async () => {
    const spy: CallSpy = { calls: [] };
    const acc = new RateLimitAccountant(cadence([10, 30]));
    const t0 = 1_000_000;

    const first = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "first",
        idempotency_key: "k-a",
      },
      { discord: fakeDiscord(spy), ledger, accountant: acc, now: () => t0 },
    );
    expect(first.status).toBe("ok");

    const second = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "second",
        idempotency_key: "k-b",
      },
      {
        discord: fakeDiscord(spy),
        ledger,
        accountant: acc,
        now: () => t0 + 5 * 60_000,
      },
    );
    expect(second.status).toBe("failed");
    expect(spy.calls).toHaveLength(1); // child NOT called for the rate-limited one
    expect(second.warnings.some((w) => /retry_after_seconds=\d+/.test(w))).toBe(
      true,
    );
    // rate-limit-rejected calls are NOT cached in the ledger — operator can retry later
    expect(ledger.lookup("k-b")).toBeNull();
  });

  it("records platform_rate_limit feedback into the accountant", async () => {
    const spy: CallSpy = {
      calls: [],
      result: {
        status: "ok",
        platform_response_id: "msg-x",
        idempotency_key: "k-x",
        telemetry_span_id: null,
        warnings: [],
        platform_rate_limit: { retry_after_seconds: 1800 }, // 30 min
      },
    };
    const acc = new RateLimitAccountant(cadence([1, 5])); // tiny cadence
    const t0 = 2_000_000;

    const first = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "x",
        idempotency_key: "k-x",
      },
      { discord: fakeDiscord(spy), ledger, accountant: acc, now: () => t0 },
    );
    expect(first.status).toBe("ok");
    expect(first.platform_rate_limit?.retry_after_seconds).toBe(1800);

    // 5 minutes later — well past the 1-minute cadence, but inside the
    // 30-minute platform backoff. Must be denied.
    const second = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "y",
        idempotency_key: "k-y",
      },
      {
        discord: fakeDiscord(spy),
        ledger,
        accountant: acc,
        now: () => t0 + 5 * 60_000,
      },
    );
    expect(second.status).toBe("failed");
    expect(second.warnings.some((w) => /retry_after_seconds=\d+/.test(w))).toBe(
      true,
    );
  });

  it("records failed child responses in the ledger (no retry-of-failure auto-recovery)", async () => {
    const spy: CallSpy = { calls: [], throws: new Error("child died") };
    const acc = new RateLimitAccountant(cadence([0, 0]));
    const a = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "x",
        idempotency_key: "k-fail",
      },
      { discord: fakeDiscord(spy), ledger, accountant: acc, now: () => 0 },
    );
    expect(a.status).toBe("failed");
    // second call: deduped, returns the original failure
    const b = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "x",
        idempotency_key: "k-fail",
      },
      { discord: fakeDiscord(spy), ledger, accountant: acc, now: () => 1000 },
    );
    expect(b.status).toBe("deduped");
    expect(spy.calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement the new verb wiring**

Path: `packages/core/src/verbs/post_to_community.ts`
```typescript
import { randomUUID } from "node:crypto";
import type {
  PostToCommunityInput,
  VerbResult,
} from "@social-manifold/contracts";
import { getScheme } from "../router/route-by-uri.js";
import { DiscordChildClient } from "../child-clients/discord.js";
import { IdempotencyLedger } from "../idempotency/ledger.js";
import { RateLimitAccountant } from "../ratelimit/accountant.js";

export interface PostToCommunityDeps {
  discord: DiscordChildClient;
  ledger: IdempotencyLedger;
  accountant: RateLimitAccountant;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export async function postToCommunity(
  input: PostToCommunityInput,
  deps: PostToCommunityDeps,
): Promise<VerbResult> {
  const idempotencyKey = input.idempotency_key ?? randomUUID();
  const now = deps.now ?? (() => Date.now());

  // 1. dedup check (only if caller supplied a key — generated UUIDs would
  //    never hit, so the lookup is a free no-op then)
  if (input.idempotency_key) {
    const cached = deps.ledger.lookup(idempotencyKey);
    if (cached) return cached;
  }

  // 2. parse + route by scheme
  const scheme = getScheme(input.community_ref);
  if (scheme === null) {
    return failed(
      idempotencyKey,
      `unrecognized community_ref scheme: ${input.community_ref}`,
    );
  }
  if (scheme !== "discord") {
    return failed(idempotencyKey, `unsupported platform: ${scheme}`);
  }

  // 3. rate-limit check (per-persona behavioral + platform backoff). NOT
  //    cached in the ledger if denied — the operator should retry once the
  //    window opens, with the same key, and that retry should hit.
  const reservation = await deps.accountant.checkAndReserve(
    input.persona_id,
    "discord",
    now(),
  );
  if (!reservation.allowed) {
    return failed(
      idempotencyKey,
      `rate-limited: retry_after_seconds=${reservation.retry_after_seconds}`,
    );
  }

  // 4. forward to child
  let childResult: VerbResult;
  try {
    childResult = await deps.discord.postToCommunity({
      ...input,
      idempotency_key: idempotencyKey,
    });
  } catch (err) {
    childResult = failed(idempotencyKey, (err as Error).message);
  }

  // 5. if child observed a platform-level rate limit, feed it back to the
  //    accountant so future checks respect the backoff
  if (childResult.platform_rate_limit) {
    deps.accountant.recordPlatformBackoff(
      input.persona_id,
      "discord",
      childResult.platform_rate_limit.retry_after_seconds,
      now(),
    );
  }

  // 6. record in ledger so subsequent retries with the same key are deduped
  deps.ledger.record(
    idempotencyKey,
    input.persona_id,
    "post_to_community",
    childResult,
  );

  return childResult;
}

function failed(idempotencyKey: string, warning: string): VerbResult {
  return {
    status: "failed",
    platform_response_id: null,
    idempotency_key: idempotencyKey,
    telemetry_span_id: null,
    warnings: [warning],
  };
}
```

- [ ] **Step 3: Update `packages/core/src/server.ts`**

```typescript
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DiscordChildClient } from "./child-clients/discord.js";
import { IdempotencyLedger } from "./idempotency/ledger.js";
import { RateLimitAccountant } from "./ratelimit/accountant.js";
import { IdentityLoader } from "./ratelimit/identity-loader.js";
import { postToCommunity } from "./verbs/post_to_community.js";

const PostToCommunityShape = {
  persona_id: z.string().min(1),
  community_ref: z.string().min(1),
  content: z.string().min(1),
  media: z
    .array(
      z.object({
        kind: z.enum(["image", "video", "link"]),
        url: z.string().url(),
        alt_text: z.string().optional(),
      }),
    )
    .optional(),
  idempotency_key: z.string().optional(),
};

export interface CreateServerOptions {
  discord: DiscordChildClient;
  ledger: IdempotencyLedger;
  accountant: RateLimitAccountant;
}

export function createServer(opts: CreateServerOptions): McpServer {
  const server = new McpServer({
    name: "social-manifold-core",
    version: "0.0.1",
  });

  server.registerTool(
    "post_to_community",
    {
      description: "Publish original content to a named community/channel.",
      inputSchema: PostToCommunityShape,
    },
    async (args) => {
      const result = await postToCommunity(args, {
        discord: opts.discord,
        ledger: opts.ledger,
        accountant: opts.accountant,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const discordSocket =
    process.env.CHILD_DISCORD_SOCKET_PATH ??
    "/run/social-manifold/children/discord.sock";
  const ledgerPath =
    process.env.CORE_IDEMPOTENCY_DB ??
    "/var/lib/social-manifold/idempotency.db";
  const personasRoot =
    process.env.CORE_PERSONAS_ROOT ?? "/var/social-manifold/personas";

  const discord = new DiscordChildClient({ socketPath: discordSocket });
  const ledger = new IdempotencyLedger(ledgerPath);
  const accountant = new RateLimitAccountant(new IdentityLoader(personasRoot));

  const server = createServer({ discord, ledger, accountant });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 4: Update `packages/core/tests/server.test.ts`** to pass the new deps

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { IdempotencyLedger } from "../src/idempotency/ledger.js";
import { RateLimitAccountant } from "../src/ratelimit/accountant.js";
import type { DiscordChildClient } from "../src/child-clients/discord.js";

const fakeDiscord = {
  postToCommunity: async (input: { idempotency_key?: string }) => ({
    status: "ok",
    platform_response_id: "fake-msg-9",
    idempotency_key: input.idempotency_key ?? "generated",
    telemetry_span_id: null,
    warnings: [],
  }),
} as unknown as DiscordChildClient;

describe("MCP server", () => {
  let dir: string;
  let ledger: IdempotencyLedger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "srv-"));
    ledger = new IdempotencyLedger(join(dir, "idem.db"));
    return () => {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    };
  });

  it("lists post_to_community as a tool and dispatches discord refs", async () => {
    const accountant = new RateLimitAccountant({
      cadenceMinutes: async () => [0, 0],
    });
    const server = createServer({ discord: fakeDiscord, ledger, accountant });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("post_to_community");

    const callResult = await client.callTool({
      name: "post_to_community",
      arguments: {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "hi",
        idempotency_key: "k1",
      },
    });
    const textBlock = (
      callResult.content as { type: string; text: string }[]
    )[0];
    const payload = JSON.parse(textBlock.text);
    expect(payload.status).toBe("ok");
    expect(payload.platform_response_id).toBe("fake-msg-9");
    expect(payload.idempotency_key).toBe("k1");

    await client.close();
    await server.close();
  });
});
```

- [ ] **Step 5: Run all core tests**

Run: `pnpm --filter @social-manifold/core test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/verbs/post_to_community.ts packages/core/src/server.ts packages/core/tests/post_to_community.test.ts packages/core/tests/server.test.ts
git commit -m "feat(core): wire ledger + accountant into post_to_community"
```

---

### Task 6: child-discord 429 detection (TDD)

When `@discordjs/rest` throws because of a rate limit, detect it and surface `retry_after_seconds` via `VerbResult.platform_rate_limit`. The library exposes rate-limit info on `RateLimitError`.

**Files:**
- Modify: `packages/child-discord/src/adapter.ts`
- Modify: `packages/child-discord/src/mcp-server.ts`
- Modify: `packages/child-discord/tests/adapter.test.ts`
- Modify: `packages/child-discord/tests/server.test.ts`

- [ ] **Step 1: Add adapter test for 429 detection**

Append to `packages/child-discord/tests/adapter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Credential } from "@social-manifold/persona-vault/client";
import { postMessage, RateLimitedError } from "../src/adapter.js";
import type { DiscordRestPort } from "../src/deps.js";

describe("postMessage adapter — rate limit signal", () => {
  it("propagates a RateLimitedError when REST signals 429", async () => {
    const cred = new Credential({ bot_token: "T" });
    const rest: DiscordRestPort = {
      async postMessage() {
        throw new RateLimitedError(120);
      },
    };
    await expect(
      postMessage(cred, rest, { channel_id: "c", content: "x" }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    // the credential is still consumed (Credential.use() finally)
    expect(cred.get("bot_token")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Add the RateLimitedError class to the adapter**

Edit `packages/child-discord/src/adapter.ts` — add at the top of the exports:
```typescript
export class RateLimitedError extends Error {
  constructor(public readonly retry_after_seconds: number) {
    super(`discord rate limited; retry after ${retry_after_seconds}s`);
    this.name = "RateLimitedError";
  }
}
```

The adapter itself doesn't change — `Credential.use()` still wraps and propagates whatever the REST port throws. The mcp-server is what catches `RateLimitedError` and translates it to `platform_rate_limit`.

- [ ] **Step 3: Add server test for 429 propagation through the MCP tool result**

Append to `packages/child-discord/tests/server.test.ts`:

```typescript
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport as InMemTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChildDiscordMcpServer } from "../src/mcp-server.js";
import { RateLimitedError } from "../src/adapter.js";
// (rig + helpers from setup above)

describe("child-discord MCP tool — platform rate limit surfacing", () => {
  it("translates a RateLimitedError into VerbResult.platform_rate_limit", async () => {
    const rig = await setupRig();
    try {
      const rest: DiscordRestPort = {
        async postMessage() {
          throw new RateLimitedError(60);
        },
      };
      const mcp = createChildDiscordMcpServer({ vault: rig.vault, rest });
      const [clientT, serverT] = InMemTransport.createLinkedPair();
      await mcp.connect(serverT);
      const client = new McpClient({ name: "rl-test", version: "0.0.1" });
      await client.connect(clientT);

      const callResult = await client.callTool({
        name: "post_to_community",
        arguments: {
          persona_id: "p_alpha",
          community_ref: "discord://guild:1/channel:2",
          content: "x",
          idempotency_key: "ik-rl",
        },
      });
      const result = JSON.parse(
        (callResult.content as { type: string; text: string }[])[0].text,
      );
      expect(result.status).toBe("failed");
      expect(result.platform_rate_limit?.retry_after_seconds).toBe(60);

      await client.close();
      await mcp.close();
    } finally {
      await new Promise<void>((r) => rig.vaultServer.close(() => r()));
    }
  });
});
```

(Note: refactor the helpers if needed so `setupRig` is shared between the two `describe` blocks.)

- [ ] **Step 4: Update `packages/child-discord/src/mcp-server.ts`** to translate the error

Inside the `try` block, after calling `postMessage`, the catch needs to recognize `RateLimitedError`:

```typescript
} catch (err) {
  if (err instanceof RateLimitedError) {
    result = {
      status: "failed",
      platform_response_id: null,
      idempotency_key: idempotencyKey,
      telemetry_span_id: null,
      warnings: [`discord rate limited; retry_after_seconds=${err.retry_after_seconds}`],
      platform_rate_limit: { retry_after_seconds: err.retry_after_seconds },
    };
  } else {
    result = failed(idempotencyKey, (err as Error).message);
  }
}
```

Import `RateLimitedError` from `./adapter.js` at the top.

- [ ] **Step 5: Update the live REST adapter to throw `RateLimitedError` on 429**

In `packages/child-discord/src/deps.ts`, replace `liveDiscordRest`:
```typescript
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { RateLimitedError } from "./adapter.js";

export const liveDiscordRest: DiscordRestPort = {
  async postMessage(channelId, content, token) {
    const rest = new REST({ version: "10" }).setToken(token);
    try {
      const result = (await rest.post(Routes.channelMessages(channelId), {
        body: { content },
      })) as { id: string };
      return { id: result.id };
    } catch (err) {
      // @discordjs/rest throws DiscordAPIError or RateLimitError; both
      // expose .status for HTTP code. 429 means we ran past the platform's
      // last bucket; surface to the accountant via VerbResult.
      const status = (err as { status?: number }).status;
      if (status === 429) {
        const retry =
          (err as { retryAfter?: number }).retryAfter ??
          (err as { headers?: Record<string, string> }).headers?.[
            "retry-after"
          ];
        const seconds = typeof retry === "string" ? parseInt(retry, 10) : retry ?? 30;
        throw new RateLimitedError(seconds);
      }
      throw err;
    }
  },
};
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @social-manifold/child-discord test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/child-discord/src packages/child-discord/tests
git commit -m "feat(child-discord): surface platform 429s via VerbResult.platform_rate_limit"
```

---

### Task 7: Full-chain integration test for dedup + rate-limit

Augment `packages/core/tests/integration.test.ts` with two new tests: (a) a same-key retry returns `deduped` and the child is called only once, (b) a fast second call is rate-limited at the core, no child invocation.

- [ ] **Step 1: Edit `packages/core/tests/integration.test.ts`**

Add to the existing `describe`:

```typescript
it("a same-key retry returns deduped without re-invoking the child", async () => {
  // (re)create core with a tight setup pointing at the same vault+child
  const ledger = new IdempotencyLedger(join(rig.tmp, "idem.db"));
  const accountant = new RateLimitAccountant({
    cadenceMinutes: async () => [0, 0], // no throttle for this case
  });
  const discord = new DiscordChildClient({ socketPath: rig.childSocket });
  const server = createServer({ discord, ledger, accountant });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const mcpClient = new Client({ name: "dedup-test", version: "0.0.1" });
  await mcpClient.connect(ct);

  const before = rig.restCalls.length;
  const args = {
    persona_id: "p_e2e",
    community_ref: "discord://guild:1/channel:2",
    content: "dedup-content",
    idempotency_key: "ik-dedup",
  };
  const a = JSON.parse(
    ((await mcpClient.callTool({ name: "post_to_community", arguments: args }))
      .content as { type: string; text: string }[])[0].text,
  );
  const b = JSON.parse(
    ((await mcpClient.callTool({ name: "post_to_community", arguments: args }))
      .content as { type: string; text: string }[])[0].text,
  );
  expect(a.status).toBe("ok");
  expect(b.status).toBe("deduped");
  expect(b.platform_response_id).toBe(a.platform_response_id);
  // child was invoked exactly once (only for the first call)
  expect(rig.restCalls.length - before).toBe(1);

  ledger.close();
  await mcpClient.close();
  await server.close();
  await discord.close();
});

it("rate-limits a second call without invoking the child", async () => {
  const ledger = new IdempotencyLedger(join(rig.tmp, "idem-rl.db"));
  // strict 10/30 cadence
  const accountant = new RateLimitAccountant({
    cadenceMinutes: async () => [10, 30],
  });
  const discord = new DiscordChildClient({ socketPath: rig.childSocket });
  const server = createServer({ discord, ledger, accountant });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const mcpClient = new Client({ name: "rl-test", version: "0.0.1" });
  await mcpClient.connect(ct);

  const before = rig.restCalls.length;
  const a = JSON.parse(
    ((await mcpClient.callTool({
      name: "post_to_community",
      arguments: {
        persona_id: "p_e2e",
        community_ref: "discord://guild:1/channel:2",
        content: "first-rl",
        idempotency_key: "ik-rl-1",
      },
    })).content as { type: string; text: string }[])[0].text,
  );
  expect(a.status).toBe("ok");
  // immediate second call — rate-limited at the gate
  const b = JSON.parse(
    ((await mcpClient.callTool({
      name: "post_to_community",
      arguments: {
        persona_id: "p_e2e",
        community_ref: "discord://guild:1/channel:2",
        content: "second-rl",
        idempotency_key: "ik-rl-2",
      },
    })).content as { type: string; text: string }[])[0].text,
  );
  expect(b.status).toBe("failed");
  expect(b.warnings.some((w: string) => w.includes("retry_after_seconds")))
    .toBe(true);
  // exactly one new child invocation across the two MCP calls
  expect(rig.restCalls.length - before).toBe(1);

  ledger.close();
  await mcpClient.close();
  await server.close();
  await discord.close();
});
```

(Note: `rig.tmp` field needs to exist — extend the `Rig` type and `setup()` to expose the tmp dir.)

- [ ] **Step 2: Run**

Run: `pnpm -r build && pnpm --filter @social-manifold/core test`
Expected: integration tests all pass.

- [ ] **Step 3: Commit**

```bash
git add packages/core/tests/integration.test.ts
git commit -m "test(core): integration coverage for dedup and rate-limit gates"
```

---

### Task 8: docker-compose + Dockerfile + runbook updates

**Files:**
- Modify: `packages/core/Dockerfile` — add build deps for `better-sqlite3` (alpine `python3 make g++`)
- Modify: `docker-compose.yml` — named volume for the SQLite db; mount `./personas:ro` on core
- Modify: `ops/local/runbook.md` — note about restart-clear behavior

- [ ] **Step 1: Update `packages/core/Dockerfile`**

Add alpine build deps before `pnpm install` in the build stage:
```dockerfile
RUN apk add --no-cache python3 make g++
```
And in the runtime stage we don't need them; better-sqlite3's compiled binary travels with the deploy artifact.

(Verify: alpine's libc compatibility with the precompiled prebuilds may obviate the build deps. If `better-sqlite3` has alpine prebuilds for the current version, the apk add line is unnecessary. Check at build time.)

- [ ] **Step 2: Update `docker-compose.yml`**

Edit the `core` service:
```yaml
  core:
    build:
      context: .
      dockerfile: packages/core/Dockerfile
    image: social-manifold/core:dev
    stdin_open: true
    tty: false
    restart: "no"
    environment:
      CORE_IDEMPOTENCY_DB: /var/lib/social-manifold/idempotency.db
      CORE_PERSONAS_ROOT: /var/social-manifold/personas
      CHILD_DISCORD_SOCKET_PATH: /run/social-manifold/children/discord.sock
    networks:
      - manifold_core
    volumes:
      - ./personas:/var/social-manifold/personas:ro
      - core_state:/var/lib/social-manifold
      - /run/social-manifold:/run/social-manifold
```
Add to volumes at file end:
```yaml
  core_state:
```

- [ ] **Step 3: Update `ops/local/runbook.md`**

Add a "Rate-limit accountant: state lifecycle" subsection:
```markdown
### Rate-limit accountant state

Per-persona last-action timestamps live in the core's process memory and clear on restart. After `docker compose restart core`, the very first action per (persona, platform) sees no behavioral throttle — the cadence floor activates from the first action onward.

This is fine for the typical operational pattern (restart, take one un-throttled action, normal cadence resumes). If you're restarting often during a staged rollout AND want strict cadence from the first post, wait `posting_cadence_minutes[0]` after restart before issuing the first verb call.

The idempotency ledger does NOT have this caveat — it's SQLite-backed in `core_state` and survives restarts.
```

- [ ] **Step 4: Build images**

Run: `docker compose build`
Expected: all three images build.

- [ ] **Step 5: Commit**

```bash
git add packages/core/Dockerfile docker-compose.yml ops/local/runbook.md
git commit -m "feat(ops): persist idempotency ledger across restarts; mount personas read-only on core"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run all tests**

Run: `pnpm test`
Expected: all packages pass.

- [ ] **Step 2: Build + image build**

Run: `pnpm -r build && docker compose build`

- [ ] **Step 3: Self-review checklist**

- [ ] CLAUDE.md amendments visible in the diff (§4 and §9), not buried
- [ ] Dedup test asserts child invocation count, not just response shape
- [ ] Rate-limit test asserts the child is NOT invoked for the rejected call
- [ ] `platform_rate_limit` round-trips through ledger (test: rich VerbResult preserves it on dedup)
- [ ] No `bot_token_sentinel` in any test response (still holds from Plan 3)

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin plan-4-idempotency-ratelimit
gh pr create --title "Plan 4: idempotency ledger + rate-limit accountant" --body "..."
```

PR body lists:
- Summary
- D1–D7 with reasoning
- CLAUDE.md amendments A and B (called out explicitly per project_persona_decisions.md / feedback_claude_md_amendments.md)
- Test plan
- Deferred items
