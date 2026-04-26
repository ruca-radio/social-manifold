# Child-Reddit MCP — Plan 5

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@social-manifold/child-reddit` as the second platform child and the first real test of how generalizable the child-MCP pattern is. Implement `post_to_community` for self-posts to a subreddit. Stress-test: (a) the MCP-as-transport pattern with two children at once, (b) OAuth-with-refresh credential handling vs. Discord's static bot token, (c) per-platform rate-limit semantics and the `platform_rate_limit` feedback loop, (d) content adapter generalization across platforms with different content shapes.

**Architecture:** child-reddit is an MCP server bound to `/run/social-manifold/children/reddit.sock` (mode 0660, group `social-manifold` — same pattern as discord). It registers `post_to_community` as a tool. Inside the handler: parse the `reddit://r/<sub>` URI → fetch credentials from vault → use OAuth refresh to obtain (or reuse cached) access_token → call Reddit REST API → return `VerbResult`. The core's router gains a `reddit` scheme dispatcher; the verb logic in core stays unchanged (forwards to the matching child).

```
HERMES → core (post_to_community)
            │
            ▼
         scheme = "reddit"
            │
            ▼
         RedditChildClient (MCP/UDS) ─────► child-reddit MCP
                                              │
                                              ▼
                                           AccessTokenCache.tokenFor(persona)
                                              │ miss → vault.getCredential
                                              │       → exchange refresh_token
                                              │         for access_token
                                              │       → cache with expiry
                                              ▼
                                           reddit REST: POST /api/submit
                                              │
                                              ▼
                                           VerbResult (status: ok / failed,
                                                       optional platform_rate_limit)
```

**Tech Stack:** Node 20, TypeScript 5, `undici` (REST and OAuth — already a workspace dep via core; child-reddit will declare its own), Vitest with mocked Reddit at the boundary.

**Scope (covers §15 step 5 only):** child-reddit with **one verb (`post_to_community` for self-posts)**, OAuth refresh-token flow, integration into core routing. Other Reddit verbs (`reply_to_thread`, `engage_thread`, `monitor_mentions`, `enumerate_communities`) deferred. Web-flow OAuth (acquiring the refresh_token via user redirect) is operator-side and out of scope for this plan; the runbook covers the manual one-time bootstrap.

---

## CLAUDE.md amendments required

### Amendment A — §5 Reddit library

Current text (line 161 in CLAUDE.md):
> | Reddit | OAuth2 (snoowrap) | None | Honor per-subreddit rules. Throttle aggressively — Reddit's 2023 pricing made the API unforgiving. |

Replace with:
> | Reddit | OAuth2 (direct REST via `undici`) | None | snoowrap last released 2022-06; snoots stuck in pre-1.0 since 2023. Both predate Reddit's 2023 API changes and are unsafe to depend on. Honor per-subreddit rules. Throttle aggressively — Reddit's 2023 pricing made the API unforgiving. |

Why: §12 ("question the assumption — SDKs lag platform reality") applies. Verified at plan time that both candidate libraries are stale; rolling our own thin REST wrapper has lower long-term maintenance risk and matches the discord adapter pattern (also REST-only via library or stdlib).

---

## Decisions surfaced

### D1. OAuth model: refresh-token flow (web-app), not script-app

Reddit has two OAuth flows:
- **Script app**: `client_id`/`client_secret`/`username`/`password` → password-grant → access_token. Simple, but Reddit deprecated password-grant for accounts with 2FA in 2023, and any modern serious account should have 2FA.
- **Web app**: `client_id`/`client_secret`/`refresh_token` → refresh-grant → access_token. Robust, works with 2FA. Refresh_token is obtained via one-time user-flow redirect (operator-side, manual).

We pick the web-app flow. The one-time redirect to obtain a refresh_token is documented in `ops/local/runbook.md` as a manual operator step, run once per persona before that persona's reddit platform can be used. The vault stores `{ client_id, client_secret, refresh_token }`.

### D2. Per-child OAuth, not generic wrapper

`AccessTokenCache` lives in `packages/child-reddit/src/auth.ts`, owned by child-reddit. We do NOT extract a generic OAuth-aware Credential wrapper for v1. Reasons:
- Different OAuth flows (Reddit refresh-grant, Mastodon authorization-code with PKCE, future X paid tiers) have different token endpoints, different param sets, different error shapes. A generic wrapper that accommodates all of them either (a) abstracts so much that each child still re-implements the specifics, or (b) bakes in assumptions that break the second child to land.
- Mastodon (next OAuth child, likely Plan 12) is far enough away that we'll know more about the actual surface area when we need it.
- Extraction is a refactor, not a redesign. We can hoist common pieces into `@social-manifold/contracts` or a new `@social-manifold/oauth` package once the duplication is concrete.

### D3. Access-token lifecycle: in-memory, per-persona, restart-clears

Mirrors the rate-limit accountant pattern (Plan 4 D5). The `AccessTokenCache` is a `Map<persona_id, { access_token, expires_at_ms }>`. On `tokenFor(persona_id)`:
- If cached AND `now < expires_at_ms - REFRESH_BUFFER_MS` (60s): return cached.
- Else: fetch credential from vault → exchange refresh_token for access_token → cache with `expires_at_ms = now + (expires_in - REFRESH_BUFFER_MS) * 1000` → return.

Refresh-on-401 (token revoked mid-flight) is a stretch case for v1: the call fails and surfaces in `VerbResult.warnings`; the next call's cache lookup will refresh. Documented as an acceptable limitation.

### D4. Content shape: title derived from content via paragraph-split heuristic

Reddit self-posts require `title` (max 300 chars) and optionally `text` (max 40000 chars). The current `PostToCommunityInput` has only `content` — no title. Two options:
- (a) Extend the contract with optional `title` (CLAUDE.md §4 amendment).
- (b) Derive title from content via a documented heuristic.

Picking (b) for v1: the operator formats content as `Title here\n\nBody here` (paragraph break separator). If no `\n\n`, the entire first line up to 300 chars becomes the title and the rest becomes the body. If single-line and ≤300 chars, that's the title with no body.

If real-world use shows operators routinely fighting this, we extend the contract. Until then, heuristic + documentation is lower-friction.

### D5. community_ref shape: `reddit://r/<subreddit>`

For posting, the URI is `reddit://r/<subreddit_name>`. Subreddit names per Reddit's rules: alphanumeric + underscore, 3-21 chars. Validation in the URI parser. Other Reddit URI shapes (`reddit://r/<sub>/comments/<post_id>` for comment threads) are reserved for `reply_to_thread` (deferred).

### D6. Per-platform rate-limit feedback path is unchanged

Reddit's rate limits are per-OAuth-app (60 req/min for OAuth bots, lower for unauthenticated) and surface as HTTP 429 with `X-Ratelimit-Reset` and `X-Ratelimit-Remaining` headers. child-reddit's adapter detects 429 and throws `RateLimitedError` (same class as discord's, hoisted to `@social-manifold/contracts` if duplication is unbearable; for v1 each child gets its own copy). The mcp-server translates to `VerbResult.platform_rate_limit`. Core's accountant records.

No new core logic. The accountant's two-layer model (Plan 4 D4) handles Reddit just like Discord. If we hit Reddit's per-app limit (across all personas), the warning fires on whichever persona triggered it and the accountant blocks that persona; other personas' calls are unaffected. That's slightly wrong in principle (the per-app limit is a global property, not per-persona) but is good enough for v1 — at our scale, per-persona cadence dominates.

### D7. Audit granularity shifts from per-action to per-token-refresh

With the OAuth model, vault.getCredential is called only on cache miss/refresh — roughly once per token lifetime per persona (~1 hour for Reddit). The vault audit log accordingly shows refresh events, not per-action events. Per-action audit becomes the child's responsibility (deferred to telemetry plan, §15 step 6).

Documented in `ops/local/runbook.md` so the operator doesn't read the vault audit and conclude the child is silent.

### D8. Mocked Reddit API; no live integration tests

Same posture as Plan 3. Test seams: `RedditOAuthPort` (token endpoint) and `RedditRestPort` (Reddit API endpoints). Live integration tests deferred until a real staging Reddit account with a configured OAuth app and an obtained refresh_token exists. Reddit's ban speed for unwarmed bot accounts is faster than Discord's, so the staging-account discipline matters more here — documented in the runbook.

### D9. snoowrap → direct REST (covered by Amendment A)

See above.

---

## File structure

```
packages/child-reddit/                  ← NEW
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── Dockerfile
├── src/
│   ├── server.ts                       # MCP UDS entrypoint
│   ├── mcp-server.ts                   # McpServer + post_to_community tool
│   ├── adapter.ts                      # REST submit + RateLimitedError
│   ├── auth.ts                         # AccessTokenCache + refresh logic
│   ├── uri.ts                          # parseRedditRef
│   └── deps.ts                         # RedditOAuthPort, RedditRestPort, live impls
└── tests/
    ├── adapter.test.ts
    ├── auth.test.ts
    ├── uri.test.ts
    └── server.test.ts

packages/core/src/
├── child-clients/
│   └── reddit.ts                       # NEW — MCP client to child-reddit
├── verbs/
│   └── post_to_community.ts            # MODIFIED — handle reddit scheme
└── server.ts                           # MODIFIED — instantiate reddit client

docker-compose.yml                      ← MODIFIED — child-reddit service
CLAUDE.md                               ← MODIFIED — Amendment A (§5)
personas/_staging_alpha/identity.yaml   ← MODIFIED — enable reddit platform
ops/local/runbook.md                    ← MODIFIED — Reddit OAuth bootstrap, audit shift, ban-speed warning
```

---

### Task 1: CLAUDE.md amendment + plan doc

- [ ] **Step 1: Apply Amendment A to CLAUDE.md §5**

In the per-platform table, find the Reddit row and replace the entry per Amendment A above.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md docs/superpowers/plans/2026-04-26-child-reddit.md
git commit -m "docs(claude): drop snoowrap from §5; switch Reddit to direct REST via undici"
```

---

### Task 2: child-reddit package skeleton + URI parser (TDD)

**Files:**
- Create: `packages/child-reddit/{package.json, tsconfig.json, vitest.config.ts}`
- Create: `packages/child-reddit/src/uri.ts`
- Create: `packages/child-reddit/tests/uri.test.ts`

- [ ] **Step 1: Create `packages/child-reddit/package.json`**

```json
{
  "name": "@social-manifold/child-reddit",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/server.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.4",
    "@social-manifold/contracts": "workspace:*",
    "@social-manifold/persona-vault": "workspace:*",
    "undici": "^6.21.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `packages/child-reddit/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `packages/child-reddit/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
  },
});
```

- [ ] **Step 4: Write the URI test**

Path: `packages/child-reddit/tests/uri.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { parseRedditRef } from "../src/uri.js";

describe("parseRedditRef", () => {
  it("parses a valid subreddit ref", () => {
    expect(parseRedditRef("reddit://r/selfhosted")).toEqual({
      subreddit: "selfhosted",
    });
  });

  it("accepts underscore in subreddit names", () => {
    expect(parseRedditRef("reddit://r/local_llm")).toEqual({
      subreddit: "local_llm",
    });
  });

  it("rejects names shorter than 3 chars", () => {
    expect(parseRedditRef("reddit://r/ab")).toBeNull();
  });

  it("rejects names longer than 21 chars", () => {
    expect(parseRedditRef(`reddit://r/${"x".repeat(22)}`)).toBeNull();
  });

  it("rejects non-alphanumeric (other than underscore)", () => {
    expect(parseRedditRef("reddit://r/has-dash")).toBeNull();
    expect(parseRedditRef("reddit://r/has space")).toBeNull();
  });

  it("rejects malformed schemes", () => {
    expect(parseRedditRef("reddit://comments/abc")).toBeNull();
    expect(parseRedditRef("not-reddit://r/foo")).toBeNull();
    expect(parseRedditRef("")).toBeNull();
  });

  it("rejects comment-thread refs (reserved for reply_to_thread)", () => {
    expect(
      parseRedditRef("reddit://r/selfhosted/comments/abc123"),
    ).toBeNull();
  });
});
```

- [ ] **Step 5: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/child-reddit test`
Expected: module not found (after `pnpm install`).

- [ ] **Step 6: Implement `packages/child-reddit/src/uri.ts`**

```typescript
export interface RedditCommunityRef {
  subreddit: string;
}

const REDDIT = /^reddit:\/\/r\/([A-Za-z0-9_]{3,21})$/;

export function parseRedditRef(ref: string): RedditCommunityRef | null {
  const m = ref.match(REDDIT);
  if (!m) return null;
  return { subreddit: m[1] };
}
```

- [ ] **Step 7: Install + run, expect PASS**

```bash
pnpm install
pnpm --filter @social-manifold/child-reddit test
```
Expected: 7 URI tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/child-reddit pnpm-lock.yaml
git commit -m "feat(child-reddit): package skeleton + URI parser"
```

---

### Task 3: AccessTokenCache + OAuth refresh (TDD)

**Files:**
- Create: `packages/child-reddit/src/auth.ts`
- Create: `packages/child-reddit/tests/auth.test.ts`

The cache holds access_tokens keyed by persona_id; on miss/expiry it calls a `RedditOAuthPort` to exchange the refresh_token for a new access_token. The OAuth port is injectable; tests use a fake port.

- [ ] **Step 1: Write the test**

Path: `packages/child-reddit/tests/auth.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { Credential } from "@social-manifold/persona-vault/client";
import { AccessTokenCache, type RedditOAuthPort } from "../src/auth.js";
import type { VaultClient } from "@social-manifold/persona-vault/client";

interface OAuthCallSpy {
  calls: Array<{ refresh_token: string; client_id: string }>;
}

function fakeOAuth(
  spy: OAuthCallSpy,
  opts: { token?: string; expiresIn?: number; throws?: Error } = {},
): RedditOAuthPort {
  return {
    async exchangeRefreshToken({ client_id, client_secret, refresh_token }) {
      spy.calls.push({ refresh_token, client_id });
      if (opts.throws) throw opts.throws;
      return {
        access_token: opts.token ?? "access-1",
        expires_in: opts.expiresIn ?? 3600,
      };
    },
  };
}

function fakeVault(perCallCred: () => Credential): VaultClient {
  return {
    getCredential: async () => perCallCred(),
  } as unknown as VaultClient;
}

describe("AccessTokenCache", () => {
  it("fetches a fresh token on first lookup", async () => {
    const oauthSpy: OAuthCallSpy = { calls: [] };
    const cache = new AccessTokenCache(
      fakeVault(() =>
        new Credential({
          client_id: "ID",
          client_secret: "SECRET",
          refresh_token: "RT",
        }),
      ),
      fakeOAuth(oauthSpy),
      () => 1_000_000,
    );
    const t = await cache.tokenFor("p1");
    expect(t).toBe("access-1");
    expect(oauthSpy.calls).toHaveLength(1);
    expect(oauthSpy.calls[0].refresh_token).toBe("RT");
  });

  it("reuses the cached token when not near expiry", async () => {
    const oauthSpy: OAuthCallSpy = { calls: [] };
    let now = 1_000_000;
    const cache = new AccessTokenCache(
      fakeVault(() =>
        new Credential({
          client_id: "ID",
          client_secret: "SECRET",
          refresh_token: "RT",
        }),
      ),
      fakeOAuth(oauthSpy),
      () => now,
    );
    await cache.tokenFor("p1");
    now += 100_000; // ~100 sec later, still well inside the 1h expiry
    await cache.tokenFor("p1");
    expect(oauthSpy.calls).toHaveLength(1); // cache hit, no second exchange
  });

  it("refreshes when within REFRESH_BUFFER of expiry", async () => {
    const oauthSpy: OAuthCallSpy = { calls: [] };
    let now = 1_000_000;
    const cache = new AccessTokenCache(
      fakeVault(() =>
        new Credential({
          client_id: "ID",
          client_secret: "SECRET",
          refresh_token: "RT",
        }),
      ),
      fakeOAuth(oauthSpy, { expiresIn: 100 }),
      () => now,
    );
    await cache.tokenFor("p1");
    now += 50_000; // 50 sec later — inside 60-sec refresh buffer
    await cache.tokenFor("p1");
    expect(oauthSpy.calls).toHaveLength(2);
  });

  it("isolates tokens by persona", async () => {
    const oauthSpy: OAuthCallSpy = { calls: [] };
    let nextToken = 0;
    const cache = new AccessTokenCache(
      fakeVault(() =>
        new Credential({
          client_id: "ID",
          client_secret: "SECRET",
          refresh_token: `RT-${nextToken++}`,
        }),
      ),
      {
        async exchangeRefreshToken({ refresh_token }) {
          oauthSpy.calls.push({ refresh_token, client_id: "ID" });
          return {
            access_token: `T-${refresh_token}`,
            expires_in: 3600,
          };
        },
      },
      () => 1_000_000,
    );
    const a = await cache.tokenFor("p1");
    const b = await cache.tokenFor("p2");
    expect(a).not.toBe(b);
    expect(oauthSpy.calls).toHaveLength(2);
  });

  it("consumes the Credential during refresh (verifies .use() contract)", async () => {
    const oauthSpy: OAuthCallSpy = { calls: [] };
    let observedCred: Credential | null = null;
    const cred = new Credential({
      client_id: "ID",
      client_secret: "SECRET",
      refresh_token: "RT",
    });
    const cache = new AccessTokenCache(
      {
        getCredential: async () => {
          observedCred = cred;
          return cred;
        },
      } as unknown as VaultClient,
      fakeOAuth(oauthSpy),
      () => 1_000_000,
    );
    await cache.tokenFor("p1");
    // post-refresh, the credential we observed has been consumed
    expect(observedCred).not.toBeNull();
    expect((observedCred as Credential).get("refresh_token")).toBeUndefined();
  });

  it("throws when OAuth port returns an error", async () => {
    const oauthSpy: OAuthCallSpy = { calls: [] };
    const cache = new AccessTokenCache(
      fakeVault(() =>
        new Credential({
          client_id: "ID",
          client_secret: "SECRET",
          refresh_token: "RT",
        }),
      ),
      fakeOAuth(oauthSpy, { throws: new Error("invalid_grant") }),
      () => 1_000_000,
    );
    await expect(cache.tokenFor("p1")).rejects.toThrow(/invalid_grant/);
  });

  it("never logs the refresh_token via JSON.stringify on the cache", async () => {
    const oauthSpy: OAuthCallSpy = { calls: [] };
    const cache = new AccessTokenCache(
      fakeVault(() =>
        new Credential({
          client_id: "ID",
          client_secret: "SECRET",
          refresh_token: "REFRESH-SENTINEL-9X2",
        }),
      ),
      fakeOAuth(oauthSpy, { token: "ACCESS-OK" }),
      () => 1_000_000,
    );
    await cache.tokenFor("p1");
    // The cache holds access_token (which is short-lived) but NEVER the
    // refresh_token. JSON.stringify on the cache should not contain the
    // refresh_token sentinel.
    expect(JSON.stringify(cache)).not.toContain("REFRESH-SENTINEL-9X2");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/child-reddit test`
Expected: auth tests fail (module not found).

- [ ] **Step 3: Implement**

Path: `packages/child-reddit/src/auth.ts`
```typescript
import type { VaultClient } from "@social-manifold/persona-vault/client";

export interface RedditOAuthExchange {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

export interface RedditOAuthResponse {
  access_token: string;
  expires_in: number;
}

export interface RedditOAuthPort {
  exchangeRefreshToken(input: RedditOAuthExchange): Promise<RedditOAuthResponse>;
}

interface CacheEntry {
  access_token: string;
  expires_at_ms: number;
}

const REFRESH_BUFFER_MS = 60_000;

/**
 * Per-persona access-token cache for Reddit OAuth.
 *
 *   On tokenFor(persona_id):
 *     - cache hit AND now < expires_at_ms - 60s → return cached
 *     - else → vault.getCredential → .use(refresh_token → OAuth exchange)
 *               → cache result → return access_token
 *
 * The refresh_token never lives in this cache. Only the short-lived
 * access_token does. The Credential consumption happens inside .use(),
 * so the refresh_token is wiped from the wrapper after each refresh.
 *
 * Restart clears the cache (Plan 5 D3 + ops/local/runbook.md).
 */
export class AccessTokenCache {
  #cache = new Map<string, CacheEntry>();

  constructor(
    private readonly vault: VaultClient,
    private readonly oauth: RedditOAuthPort,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async tokenFor(personaId: string): Promise<string> {
    const cached = this.#cache.get(personaId);
    if (cached && this.now() < cached.expires_at_ms - REFRESH_BUFFER_MS) {
      return cached.access_token;
    }

    const cred = await this.vault.getCredential(personaId, "reddit", {
      requester_id: "child-reddit",
      purpose: `oauth_refresh:${personaId}`,
    });

    const result = await cred.use(async (raw) => {
      const { client_id, client_secret, refresh_token } = raw;
      if (!client_id || !client_secret || !refresh_token) {
        throw new Error(
          "child-reddit auth: credential bundle missing client_id, client_secret, or refresh_token",
        );
      }
      return this.oauth.exchangeRefreshToken({
        client_id,
        client_secret,
        refresh_token,
      });
    });

    const expires_at_ms = this.now() + result.expires_in * 1000;
    this.#cache.set(personaId, {
      access_token: result.access_token,
      expires_at_ms,
    });
    return result.access_token;
  }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @social-manifold/child-reddit test`
Expected: 7 auth tests pass + 7 URI tests = 14.

- [ ] **Step 5: Commit**

```bash
git add packages/child-reddit/src/auth.ts packages/child-reddit/tests/auth.test.ts
git commit -m "feat(child-reddit): AccessTokenCache with OAuth refresh-token flow"
```

---

### Task 4: Adapter (TDD)

**Files:**
- Create: `packages/child-reddit/src/deps.ts`
- Create: `packages/child-reddit/src/adapter.ts`
- Create: `packages/child-reddit/tests/adapter.test.ts`

The adapter does the actual `POST /api/submit` (kind=self, sr=subreddit, title, text), takes a pre-resolved access_token (the auth module handles refresh upstream). Mirrors the discord adapter shape.

- [ ] **Step 1: Create `packages/child-reddit/src/deps.ts`**

```typescript
import { Agent, fetch as undiciFetch } from "undici";
import { RateLimitedError } from "./adapter.js";

export interface RedditSubmitInput {
  subreddit: string;
  title: string;
  text: string;
}

export interface RedditSubmitResult {
  permalink: string;
}

export interface RedditRestPort {
  submit(
    accessToken: string,
    input: RedditSubmitInput,
  ): Promise<RedditSubmitResult>;
}

export interface RedditOAuthLivePort {
  exchangeRefreshToken(input: {
    client_id: string;
    client_secret: string;
    refresh_token: string;
  }): Promise<{ access_token: string; expires_in: number }>;
}

const USER_AGENT = "social-manifold/0.0.1 (+https://github.com/ruca-radio/social-manifold)";

/** Production REST adapter — direct calls to oauth.reddit.com. */
export const liveRedditRest: RedditRestPort = {
  async submit(accessToken, input) {
    const body = new URLSearchParams({
      api_type: "json",
      kind: "self",
      sr: input.subreddit,
      title: input.title,
      text: input.text,
    });
    const res = await undiciFetch("https://oauth.reddit.com/api/submit", {
      method: "POST",
      headers: {
        authorization: `bearer ${accessToken}`,
        "user-agent": USER_AGENT,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (res.status === 429) {
      const retry = res.headers.get("x-ratelimit-reset") ?? res.headers.get("retry-after");
      const seconds = retry ? parseInt(retry, 10) : 60;
      throw new RateLimitedError(Number.isFinite(seconds) ? seconds : 60);
    }
    if (!res.ok) {
      throw new Error(`reddit submit ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      json: { data?: { url?: string }; errors?: unknown[] };
    };
    if (json.json.errors && json.json.errors.length > 0) {
      throw new Error(`reddit submit errors: ${JSON.stringify(json.json.errors)}`);
    }
    return { permalink: json.json.data?.url ?? "" };
  },
};

const DUAL_AGENT = new Agent({
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 60_000,
});

/** Production OAuth port — exchanges refresh_token for access_token. */
export const liveRedditOAuth: RedditOAuthLivePort = {
  async exchangeRefreshToken({ client_id, client_secret, refresh_token }) {
    const basic = Buffer.from(`${client_id}:${client_secret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token,
    });
    const res = await undiciFetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "user-agent": USER_AGENT,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      dispatcher: DUAL_AGENT,
    });
    if (!res.ok) {
      throw new Error(`reddit oauth ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    return { access_token: json.access_token, expires_in: json.expires_in };
  },
};
```

- [ ] **Step 2: Write the adapter test**

Path: `packages/child-reddit/tests/adapter.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { deriveTitleAndBody, postSelf, RateLimitedError } from "../src/adapter.js";
import type { RedditRestPort } from "../src/deps.js";

interface CallSpy {
  calls: Array<{
    accessToken: string;
    subreddit: string;
    title: string;
    text: string;
  }>;
}

function fakeRest(spy: CallSpy): RedditRestPort {
  return {
    async submit(accessToken, input) {
      spy.calls.push({ accessToken, ...input });
      return { permalink: "/r/foo/comments/abc/title/" };
    },
  };
}

describe("deriveTitleAndBody", () => {
  it("splits on the first paragraph break", () => {
    expect(deriveTitleAndBody("Title here\n\nBody here")).toEqual({
      title: "Title here",
      text: "Body here",
    });
  });

  it("uses the whole content as title when single-line and short", () => {
    expect(deriveTitleAndBody("just a title")).toEqual({
      title: "just a title",
      text: "",
    });
  });

  it("truncates a long single-line title to 300 chars and puts overflow in text", () => {
    const long = "x".repeat(310);
    const r = deriveTitleAndBody(long);
    expect(r.title.length).toBe(300);
    expect(r.title).toBe("x".repeat(300));
    expect(r.text).toBe("x".repeat(10));
  });

  it("uses first \\n as title break when no paragraph break", () => {
    expect(deriveTitleAndBody("Title\nbody-line-1\nbody-line-2")).toEqual({
      title: "Title",
      text: "body-line-1\nbody-line-2",
    });
  });
});

describe("postSelf", () => {
  it("submits a self-post with the derived title and body", async () => {
    const spy: CallSpy = { calls: [] };
    const result = await postSelf(fakeRest(spy), "ACCESS-X", {
      subreddit: "selfhosted",
      content: "How I host LLMs at home\n\nI use a 4090 and ...",
    });
    expect(result.permalink).toBe("/r/foo/comments/abc/title/");
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].accessToken).toBe("ACCESS-X");
    expect(spy.calls[0].subreddit).toBe("selfhosted");
    expect(spy.calls[0].title).toBe("How I host LLMs at home");
    expect(spy.calls[0].text).toBe("I use a 4090 and ...");
  });

  it("propagates RateLimitedError", async () => {
    const rest: RedditRestPort = {
      async submit() {
        throw new RateLimitedError(120);
      },
    };
    await expect(
      postSelf(rest, "ACCESS-X", { subreddit: "x", content: "y" }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/child-reddit test`
Expected: adapter tests fail.

- [ ] **Step 4: Implement `packages/child-reddit/src/adapter.ts`**

```typescript
import type { RedditRestPort } from "./deps.js";

export class RateLimitedError extends Error {
  constructor(public readonly retry_after_seconds: number) {
    super(`reddit rate limited; retry after ${retry_after_seconds}s`);
    this.name = "RateLimitedError";
  }
}

const TITLE_MAX = 300;

export interface DerivedContent {
  title: string;
  text: string;
}

/**
 * Derive Reddit title+body from a single content blob (Plan 5 D4).
 *   "Title\n\nBody"  → { title: "Title", text: "Body" }
 *   "Title\nBody"    → { title: "Title", text: "Body" }
 *   "single line"    → { title: "single line", text: "" }
 *   long single line → title truncated to 300, overflow → text
 */
export function deriveTitleAndBody(content: string): DerivedContent {
  const paraIdx = content.indexOf("\n\n");
  if (paraIdx >= 0) {
    return {
      title: content.slice(0, paraIdx).slice(0, TITLE_MAX),
      text: content.slice(paraIdx + 2),
    };
  }
  const lineIdx = content.indexOf("\n");
  if (lineIdx >= 0) {
    return {
      title: content.slice(0, lineIdx).slice(0, TITLE_MAX),
      text: content.slice(lineIdx + 1),
    };
  }
  if (content.length <= TITLE_MAX) {
    return { title: content, text: "" };
  }
  return {
    title: content.slice(0, TITLE_MAX),
    text: content.slice(TITLE_MAX),
  };
}

export interface PostSelfInput {
  subreddit: string;
  content: string;
}

export interface PostSelfResult {
  permalink: string;
}

export async function postSelf(
  rest: RedditRestPort,
  accessToken: string,
  input: PostSelfInput,
): Promise<PostSelfResult> {
  const { title, text } = deriveTitleAndBody(input.content);
  return rest.submit(accessToken, {
    subreddit: input.subreddit,
    title,
    text,
  });
}
```

- [ ] **Step 5: Run, expect PASS**

Run: `pnpm --filter @social-manifold/child-reddit test`
Expected: 5 adapter tests pass + earlier = 19.

- [ ] **Step 6: Commit**

```bash
git add packages/child-reddit/src packages/child-reddit/tests/adapter.test.ts
git commit -m "feat(child-reddit): REST adapter, title-derivation heuristic, RateLimitedError"
```

---

### Task 5: MCP server tool (TDD with in-memory transport)

**Files:**
- Create: `packages/child-reddit/src/mcp-server.ts`
- Create: `packages/child-reddit/tests/server.test.ts`

The MCP tool: takes a `post_to_community` input, parses the URI, gets the access_token from the cache (which transparently handles refresh), calls the adapter, returns the `VerbResult`. RateLimitedError → `platform_rate_limit` (same pattern as discord).

- [ ] **Step 1: Write the test**

Path: `packages/child-reddit/tests/server.test.ts`
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVaultServer } from "@social-manifold/persona-vault";
import { VaultClient } from "@social-manifold/persona-vault/client";
import { createChildRedditMcpServer } from "../src/mcp-server.js";
import { RateLimitedError } from "../src/adapter.js";
import type { RedditOAuthPort } from "../src/auth.js";
import type { RedditRestPort } from "../src/deps.js";

const exec = promisify(execFile);

interface RedditCallSpy {
  submitCalls: Array<{ accessToken: string; subreddit: string; title: string; text: string }>;
  oauthCalls: Array<{ refresh_token: string }>;
}

interface Rig {
  vault: Server;
  vaultClient: VaultClient;
  spy: RedditCallSpy;
  rest: RedditRestPort;
  oauth: RedditOAuthPort;
  refresh_sentinel: string;
  access_sentinel: string;
}

async function setupRig(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), "cr-"));
  const personasRoot = join(tmp, "personas");
  await mkdir(join(personasRoot, "p_alpha"), { recursive: true });
  await writeFile(
    join(personasRoot, "p_alpha", "identity.yaml"),
    `id: p_alpha
display_name: "p_alpha"
type: branded_bot
timezone: UTC
locale: en-US
working_hours: "00:00-23:59"
posting_cadence_minutes: [1, 3]
proxy_pool: none
disclosed_automation: true
platforms:
  reddit:
    enabled: true
    credential_ref: reddit_oauth
`,
    "utf8",
  );
  const ageDir = await mkdtemp(join(tmpdir(), "cr-age-"));
  const ageKey = join(ageDir, "k");
  await exec("age-keygen", ["-o", ageKey]);
  await chmod(ageKey, 0o400);
  const recipient = (await readFile(ageKey, "utf8")).match(
    /# public key: (age1[a-z0-9]+)/i,
  )![1];

  const REFRESH = "REFRESH-SENTINEL-CR-MN3K";
  const ACCESS = "ACCESS-SENTINEL-CR-FX8Q";
  const credPath = join(personasRoot, "p_alpha", "credentials.sops.yaml");
  await writeFile(
    credPath,
    `reddit:\n  client_id: CID\n  client_secret: CSECRET\n  refresh_token: ${REFRESH}\n`,
    "utf8",
  );
  await exec("sops", ["--encrypt", "--age", recipient, "--in-place", credPath]);

  const socketPath = join(tmp, "v.sock");
  const vault = await createVaultServer({
    personasRoot,
    auditPath: join(tmp, "audit.jsonl"),
    ageKeyPath: ageKey,
    socketPath,
  });
  const vaultClient = new VaultClient(socketPath);

  const spy: RedditCallSpy = { submitCalls: [], oauthCalls: [] };
  const rest: RedditRestPort = {
    async submit(accessToken, input) {
      spy.submitCalls.push({ accessToken, ...input });
      return { permalink: "/r/test/comments/x/y/" };
    },
  };
  const oauth: RedditOAuthPort = {
    async exchangeRefreshToken({ refresh_token }) {
      spy.oauthCalls.push({ refresh_token });
      return { access_token: ACCESS, expires_in: 3600 };
    },
  };
  return {
    vault,
    vaultClient,
    spy,
    rest,
    oauth,
    refresh_sentinel: REFRESH,
    access_sentinel: ACCESS,
  };
}

async function callTool(
  rig: Rig,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const mcp = createChildRedditMcpServer({
    vault: rig.vaultClient,
    oauth: rig.oauth,
    rest: rig.rest,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st);
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(ct);
  try {
    const callResult = await client.callTool({
      name: "post_to_community",
      arguments: args,
    });
    return JSON.parse(
      (callResult.content as { type: string; text: string }[])[0].text,
    );
  } finally {
    await client.close();
    await mcp.close();
  }
}

describe("child-reddit MCP tool", () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await setupRig();
  });
  afterAll(async () => {
    await new Promise<void>((r) => rig.vault.close(() => r()));
  });

  it("post_to_community submits a self-post with the OAuth-fetched access token", async () => {
    const before = rig.spy.submitCalls.length;
    const result = await callTool(rig, {
      persona_id: "p_alpha",
      community_ref: "reddit://r/selfhosted",
      content: "How I run LLMs locally\n\nI use ollama on a 4090 and ...",
      idempotency_key: "ik-1",
    });
    expect(result.status).toBe("ok");
    expect(result.platform_response_id).toBe("/r/test/comments/x/y/");
    expect(result.idempotency_key).toBe("ik-1");

    const newSubmits = rig.spy.submitCalls.slice(before);
    expect(newSubmits).toHaveLength(1);
    expect(newSubmits[0].accessToken).toBe(rig.access_sentinel);
    expect(newSubmits[0].subreddit).toBe("selfhosted");
    expect(newSubmits[0].title).toBe("How I run LLMs locally");
    expect(newSubmits[0].text).toBe("I use ollama on a 4090 and ...");

    // refresh_token must NOT appear in the response anywhere
    expect(JSON.stringify(result)).not.toContain(rig.refresh_sentinel);
  });

  it("returns failed for malformed reddit ref", async () => {
    const result = await callTool(rig, {
      persona_id: "p_alpha",
      community_ref: "reddit://garbage",
      content: "x",
      idempotency_key: "ik-2",
    });
    expect(result.status).toBe("failed");
    expect((result.warnings as string[])[0]).toContain("invalid community_ref");
  });

  it("translates RateLimitedError into VerbResult.platform_rate_limit", async () => {
    const failingRest: RedditRestPort = {
      async submit() {
        throw new RateLimitedError(180);
      },
    };
    const mcp = createChildRedditMcpServer({
      vault: rig.vaultClient,
      oauth: rig.oauth,
      rest: failingRest,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcp.connect(st);
    const client = new Client({ name: "test-rl", version: "0.0.1" });
    await client.connect(ct);
    try {
      const callResult = await client.callTool({
        name: "post_to_community",
        arguments: {
          persona_id: "p_alpha",
          community_ref: "reddit://r/selfhosted",
          content: "x",
          idempotency_key: "ik-rl",
        },
      });
      const result = JSON.parse(
        (callResult.content as { type: string; text: string }[])[0].text,
      );
      expect(result.status).toBe("failed");
      expect(
        (result.platform_rate_limit as { retry_after_seconds: number })
          ?.retry_after_seconds,
      ).toBe(180);
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/child-reddit test`
Expected: server tests fail.

- [ ] **Step 3: Implement `packages/child-reddit/src/mcp-server.ts`**

```typescript
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VaultClient } from "@social-manifold/persona-vault/client";
import type { VerbResult } from "@social-manifold/contracts";
import { parseRedditRef } from "./uri.js";
import { postSelf, RateLimitedError } from "./adapter.js";
import { AccessTokenCache, type RedditOAuthPort } from "./auth.js";
import type { RedditRestPort } from "./deps.js";

export interface ChildRedditMcpDeps {
  vault: VaultClient;
  oauth: RedditOAuthPort;
  rest: RedditRestPort;
}

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

function failed(idempotencyKey: string, warning: string): VerbResult {
  return {
    status: "failed",
    platform_response_id: null,
    idempotency_key: idempotencyKey,
    telemetry_span_id: null,
    warnings: [warning],
  };
}

export function createChildRedditMcpServer(
  deps: ChildRedditMcpDeps,
): McpServer {
  const cache = new AccessTokenCache(deps.vault, deps.oauth);
  const server = new McpServer({
    name: "social-manifold-child-reddit",
    version: "0.0.1",
  });

  server.registerTool(
    "post_to_community",
    {
      description:
        "Submit a self-post to a subreddit referenced by `reddit://r/<subreddit>`.",
      inputSchema: PostToCommunityShape,
    },
    async (args) => {
      const idempotencyKey = args.idempotency_key ?? randomUUID();
      const ref = parseRedditRef(args.community_ref);

      let result: VerbResult;
      if (!ref) {
        result = failed(
          idempotencyKey,
          `child-reddit: invalid community_ref ${args.community_ref}`,
        );
      } else {
        try {
          const accessToken = await cache.tokenFor(args.persona_id);
          const posted = await postSelf(deps.rest, accessToken, {
            subreddit: ref.subreddit,
            content: args.content,
          });
          result = {
            status: "ok",
            platform_response_id: posted.permalink,
            idempotency_key: idempotencyKey,
            telemetry_span_id: null,
            warnings: [],
          };
        } catch (err) {
          if (err instanceof RateLimitedError) {
            result = {
              status: "failed",
              platform_response_id: null,
              idempotency_key: idempotencyKey,
              telemetry_span_id: null,
              warnings: [
                `reddit rate limited; retry_after_seconds=${err.retry_after_seconds}`,
              ],
              platform_rate_limit: {
                retry_after_seconds: err.retry_after_seconds,
              },
            };
          } else {
            result = failed(idempotencyKey, (err as Error).message);
          }
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @social-manifold/child-reddit test`
Expected: 3 server tests pass + earlier = 22.

- [ ] **Step 5: Commit**

```bash
git add packages/child-reddit/src/mcp-server.ts packages/child-reddit/tests/server.test.ts
git commit -m "feat(child-reddit): MCP tool wiring vault → AccessTokenCache → adapter"
```

---

### Task 6: UDS server entrypoint + Dockerfile

**Files:**
- Create: `packages/child-reddit/src/server.ts`
- Create: `packages/child-reddit/Dockerfile`

Same shape as child-discord's UDS-MCP entrypoint.

- [ ] **Step 1: Create `packages/child-reddit/src/server.ts`**

```typescript
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { unlink, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { VaultClient } from "@social-manifold/persona-vault/client";
import { createChildRedditMcpServer } from "./mcp-server.js";
import { liveRedditOAuth, liveRedditRest } from "./deps.js";
import type { RedditOAuthPort } from "./auth.js";
import type { RedditRestPort } from "./deps.js";

export interface ChildRedditServerConfig {
  socketPath: string;
  vault: VaultClient;
  oauth: RedditOAuthPort;
  rest: RedditRestPort;
}

export interface ChildRedditServerHandle {
  http: HttpServer;
  mcp: McpServer;
  close(): Promise<void>;
}

export async function createChildRedditServer(
  config: ChildRedditServerConfig,
): Promise<ChildRedditServerHandle> {
  const mcp = createChildRedditMcpServer({
    vault: config.vault,
    oauth: config.oauth,
    rest: config.rest,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);

  await mkdir(dirname(config.socketPath), { recursive: true });
  try {
    await unlink(config.socketPath);
  } catch {
    /* socket didn't exist */
  }
  const httpServer = createHttpServer((req, res) => {
    transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.socketPath, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  await chmod(config.socketPath, 0o660);

  return {
    http: httpServer,
    mcp,
    async close(): Promise<void> {
      await new Promise<void>((r) => httpServer.close(() => r()));
      await mcp.close();
    },
  };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const socketPath =
    process.env.CHILD_REDDIT_SOCKET_PATH ??
    "/run/social-manifold/children/reddit.sock";
  const vaultSocket =
    process.env.VAULT_SOCKET_PATH ?? "/run/social-manifold/vault.sock";

  const { existsSync } = await import("node:fs");
  if (!existsSync(dirname(socketPath))) {
    console.error(
      `child-reddit: socket directory ${dirname(socketPath)} does not exist. ` +
        "Run scripts/setup-runtime-dir.sh first (see ops/local/runbook.md).",
    );
    process.exit(1);
  }
  if (!existsSync(vaultSocket)) {
    console.error(
      `child-reddit: vault socket ${vaultSocket} does not exist. Is the vault running?`,
    );
    process.exit(1);
  }

  const vault = new VaultClient(vaultSocket);
  await createChildRedditServer({
    socketPath,
    vault,
    oauth: liveRedditOAuth,
    rest: liveRedditRest,
  });
  console.error(`child-reddit: MCP listening on ${socketPath}`);
}
```

- [ ] **Step 2: Create `packages/child-reddit/Dockerfile`**

```dockerfile
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
```

- [ ] **Step 3: Build to confirm**

```bash
pnpm --filter @social-manifold/child-reddit build
```

- [ ] **Step 4: Commit**

```bash
git add packages/child-reddit/src/server.ts packages/child-reddit/Dockerfile
git commit -m "feat(child-reddit): UDS-MCP entrypoint + Dockerfile"
```

---

### Task 7: Core child-client + routing (TDD)

**Files:**
- Create: `packages/core/src/child-clients/reddit.ts`
- Modify: `packages/core/src/verbs/post_to_community.ts`
- Modify: `packages/core/src/server.ts`
- Modify: `packages/core/tests/post_to_community.test.ts`
- Modify: `packages/core/vitest.config.ts` (alias child-reddit)

- [ ] **Step 1: Create `packages/core/src/child-clients/reddit.ts`**

Mirror the discord client structure exactly — same MCP-over-UDS pattern.
```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Agent, fetch as undiciFetch } from "undici";
import type { RequestInit as UndiciRequestInit } from "undici";
import type {
  PostToCommunityInput,
  VerbResult,
} from "@social-manifold/contracts";

export interface RedditChildClientConfig {
  socketPath: string;
}

export class RedditChildClient {
  #client: Client | null = null;
  #connecting: Promise<Client> | null = null;

  constructor(private readonly cfg: RedditChildClientConfig) {}

  async #ensureClient(): Promise<Client> {
    if (this.#client) return this.#client;
    if (this.#connecting) return this.#connecting;
    this.#connecting = (async () => {
      const dispatcher = new Agent({
        connect: { socketPath: this.cfg.socketPath },
      });
      const transport = new StreamableHTTPClientTransport(
        new URL("http://child-reddit/mcp"),
        {
          fetch: ((url: string | URL, init?: RequestInit) =>
            undiciFetch(url, {
              ...(init as UndiciRequestInit),
              dispatcher,
            }) as unknown as Promise<Response>) as never,
        },
      );
      const client = new Client({
        name: "social-manifold-core",
        version: "0.0.1",
      });
      await client.connect(transport);
      this.#client = client;
      this.#connecting = null;
      return client;
    })();
    return this.#connecting;
  }

  async postToCommunity(input: PostToCommunityInput): Promise<VerbResult> {
    const client = await this.#ensureClient();
    const callResult = await client.callTool({
      name: "post_to_community",
      arguments: input as unknown as Record<string, unknown>,
    });
    const blocks = callResult.content as { type: string; text: string }[];
    if (!blocks?.[0]?.text) {
      throw new Error("child-reddit: empty tool response");
    }
    return JSON.parse(blocks[0].text) as VerbResult;
  }

  async close(): Promise<void> {
    if (this.#client) {
      await this.#client.close();
      this.#client = null;
    }
  }
}
```

- [ ] **Step 2: Update `packages/core/src/verbs/post_to_community.ts`**

Add a `reddit` field to `PostToCommunityDeps`, branch on scheme:
```typescript
import type { RedditChildClient } from "../child-clients/reddit.js";
// ... existing imports

export interface PostToCommunityDeps {
  discord: DiscordChildClient;
  reddit: RedditChildClient;
  ledger: IdempotencyLedger;
  accountant: RateLimitAccountant;
  now?: () => number;
}
```

In the routing block, after the discord branch, add:
```typescript
  if (scheme === "reddit") {
    try {
      return await deps.reddit.postToCommunity({
        ...input,
        idempotency_key: idempotencyKey,
      });
    } catch (err) { /* same shape as discord branch */ }
    // include the platform_rate_limit feedback recording — extract the
    // common ok/fail path into a single forwardToChild() helper to avoid
    // duplicating the dedupe-record + accountant feedback for each child.
  }
```

Better: refactor to dispatch over a `Map<scheme, ChildClient>` and have one forwarding path. Final shape:

```typescript
import { randomUUID } from "node:crypto";
import type {
  PostToCommunityInput,
  VerbResult,
} from "@social-manifold/contracts";
import { getScheme } from "../router/route-by-uri.js";
import { DiscordChildClient } from "../child-clients/discord.js";
import { RedditChildClient } from "../child-clients/reddit.js";
import { IdempotencyLedger } from "../idempotency/ledger.js";
import { RateLimitAccountant } from "../ratelimit/accountant.js";

export interface PostToCommunityDeps {
  discord: DiscordChildClient;
  reddit: RedditChildClient;
  ledger: IdempotencyLedger;
  accountant: RateLimitAccountant;
  now?: () => number;
}

interface ChildClient {
  postToCommunity(input: PostToCommunityInput): Promise<VerbResult>;
}

export async function postToCommunity(
  input: PostToCommunityInput,
  deps: PostToCommunityDeps,
): Promise<VerbResult> {
  const idempotencyKey = input.idempotency_key ?? randomUUID();
  const now = deps.now ?? (() => Date.now());

  if (input.idempotency_key) {
    const cached = deps.ledger.lookup(idempotencyKey);
    if (cached) return cached;
  }

  const scheme = getScheme(input.community_ref);
  if (scheme === null) {
    return failed(
      idempotencyKey,
      `unrecognized community_ref scheme: ${input.community_ref}`,
    );
  }

  const child = pickChild(scheme, deps);
  if (!child) {
    return failed(idempotencyKey, `unsupported platform: ${scheme}`);
  }

  const reservation = await deps.accountant.checkAndReserve(
    input.persona_id,
    scheme,
    now(),
  );
  if (!reservation.allowed) {
    return failed(
      idempotencyKey,
      `rate-limited: retry_after_seconds=${reservation.retry_after_seconds}`,
    );
  }

  let childResult: VerbResult;
  try {
    childResult = await child.postToCommunity({
      ...input,
      idempotency_key: idempotencyKey,
    });
  } catch (err) {
    childResult = failed(idempotencyKey, (err as Error).message);
  }

  if (childResult.platform_rate_limit) {
    deps.accountant.recordPlatformBackoff(
      input.persona_id,
      scheme,
      childResult.platform_rate_limit.retry_after_seconds,
      now(),
    );
  }

  deps.ledger.record(
    idempotencyKey,
    input.persona_id,
    "post_to_community",
    childResult,
  );

  return childResult;
}

function pickChild(scheme: string, deps: PostToCommunityDeps): ChildClient | null {
  switch (scheme) {
    case "discord":
      return deps.discord;
    case "reddit":
      return deps.reddit;
    default:
      return null;
  }
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

Note the cleanup: the rate-limit accountant key now uses the actual scheme (`"discord"` or `"reddit"`) instead of hardcoded `"discord"`. That's a real correctness fix that Plan 4 dropped (Plan 4 always passed `"discord"` to the accountant); without this fix, both platforms would share rate-limit state.

- [ ] **Step 3: Update `packages/core/tests/post_to_community.test.ts`**

Tests need a `fakeReddit` alongside `fakeDiscord`. Easiest: add to existing `PostToCommunityDeps` shape; the existing tests don't pass `reddit` so we add a stub. Also add 1-2 new tests for reddit routing + cross-platform isolation.

```typescript
// near the top of the file, alongside fakeDiscord:
import type { RedditChildClient } from "../src/child-clients/reddit.js";

const stubReddit = {
  postToCommunity: async () => {
    throw new Error("reddit not used in this test");
  },
} as unknown as RedditChildClient;

// then update each call site that constructs the deps to include `reddit: stubReddit,`
```

Add new tests:
```typescript
it("routes a reddit:// ref to the reddit child", async () => {
  const discordSpy: CallSpy = { calls: [] };
  const redditSpy: CallSpy = { calls: [] };
  const reddit: RedditChildClient = {
    postToCommunity: async (input: Record<string, unknown>) => {
      redditSpy.calls.push(input);
      return {
        status: "ok",
        platform_response_id: "/r/x/comments/y/z/",
        idempotency_key: input.idempotency_key as string,
        telemetry_span_id: null,
        warnings: [],
      };
    },
  } as unknown as RedditChildClient;
  const acc = new RateLimitAccountant(cadence([0, 0]));
  const result = await postToCommunity(
    {
      persona_id: "p1",
      community_ref: "reddit://r/selfhosted",
      content: "hi",
      idempotency_key: "k-r",
    },
    {
      discord: fakeDiscord(discordSpy),
      reddit,
      ledger,
      accountant: acc,
      now: () => 0,
    },
  );
  expect(result.status).toBe("ok");
  expect(result.platform_response_id).toBe("/r/x/comments/y/z/");
  expect(discordSpy.calls).toEqual([]); // discord not invoked
  expect(redditSpy.calls).toHaveLength(1);
});

it("isolates rate-limit state across platforms (Plan 5 cleanup)", async () => {
  const discordSpy: CallSpy = { calls: [] };
  const redditSpy: CallSpy = { calls: [] };
  const reddit = {
    postToCommunity: async (input: Record<string, unknown>) => {
      redditSpy.calls.push(input);
      return {
        status: "ok",
        platform_response_id: "/r/x/y/z/",
        idempotency_key: input.idempotency_key as string,
        telemetry_span_id: null,
        warnings: [],
      };
    },
  } as unknown as RedditChildClient;
  const acc = new RateLimitAccountant(cadence([10, 30]));
  const t0 = 1_000_000;
  // post to discord — eats discord's persona slot
  const a = await postToCommunity(
    {
      persona_id: "p1",
      community_ref: "discord://guild:1/channel:2",
      content: "x",
      idempotency_key: "ka",
    },
    {
      discord: fakeDiscord(discordSpy),
      reddit,
      ledger,
      accountant: acc,
      now: () => t0,
    },
  );
  expect(a.status).toBe("ok");
  // post to reddit immediately — must NOT be blocked by discord's cadence
  const b = await postToCommunity(
    {
      persona_id: "p1",
      community_ref: "reddit://r/selfhosted",
      content: "x",
      idempotency_key: "kb",
    },
    {
      discord: fakeDiscord(discordSpy),
      reddit,
      ledger,
      accountant: acc,
      now: () => t0 + 1,
    },
  );
  expect(b.status).toBe("ok");
  expect(redditSpy.calls).toHaveLength(1);
});
```

- [ ] **Step 4: Update `packages/core/src/server.ts`**

Add `reddit: RedditChildClient` to `CreateServerOptions`, instantiate the client in the production `if (isMain)` block:
```typescript
const redditSocket =
  process.env.CHILD_REDDIT_SOCKET_PATH ??
  "/run/social-manifold/children/reddit.sock";
const reddit = new RedditChildClient({ socketPath: redditSocket });
// ... pass into createServer({ discord, reddit, ledger, accountant })
```

- [ ] **Step 5: Update `packages/core/tests/server.test.ts`**

Add `reddit: stubReddit` to the `createServer({...})` call.

- [ ] **Step 6: Update `packages/core/vitest.config.ts`**

Add aliases for child-reddit:
```typescript
"@social-manifold/child-reddit/dist/server.js": resolve(
  repoRoot,
  "packages/child-reddit/dist/server.js",
),
"@social-manifold/child-reddit/dist/deps.js": resolve(
  repoRoot,
  "packages/child-reddit/dist/deps.js",
),
```

- [ ] **Step 7: Run all tests**

Run: `pnpm test`
Expected: every test passes.

- [ ] **Step 8: Commit**

```bash
git add packages/core
git commit -m "feat(core): route reddit:// to child-reddit; isolate accountant state per platform"
```

---

### Task 8: Integration test (full chain)

**Files:**
- Modify: `packages/core/tests/integration.test.ts`

Add a new `describe` block that spins up child-reddit alongside child-discord and exercises a `reddit://` post via the full MCP chain. Reuses the existing setup pattern.

- [ ] **Step 1: Extend the integration rig to start child-reddit**

In `setup()`, after starting child-discord, also start child-reddit on a tmp UDS, with mocked OAuth/REST ports. Track `redditSubmitCalls`, `redditSocket`, etc.

- [ ] **Step 2: Add a single new integration test**

```typescript
it("reddit:// posts traverse the full MCP chain end-to-end", async () => {
  const before = rig.redditSubmitCalls.length;
  const { ledger, server } = makeCore({ ledgerName: "idem-r.db" });
  try {
    const payload = await callPost(server, {
      persona_id: "p_e2e",
      community_ref: "reddit://r/selfhosted",
      content: "Self-hosting LLMs in 2026\n\nThe state of the art is...",
      idempotency_key: "ik-r",
    });
    expect(payload.status).toBe("ok");
    expect(payload.platform_response_id).toBe("/r/test/comments/y/z/");
    expect(JSON.stringify(payload)).not.toContain(rig.refresh_sentinel);

    const newSubmits = rig.redditSubmitCalls.slice(before);
    expect(newSubmits).toHaveLength(1);
    expect(newSubmits[0].subreddit).toBe("selfhosted");
    expect(newSubmits[0].title).toBe("Self-hosting LLMs in 2026");
  } finally {
    ledger.close();
    await server.close();
  }
});
```

- [ ] **Step 3: Run**

```bash
pnpm -r build
pnpm --filter @social-manifold/core test
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/tests/integration.test.ts
git commit -m "test(core): full-chain integration for reddit posts"
```

---

### Task 9: docker-compose + identity update + runbook

**Files:**
- Modify: `docker-compose.yml`
- Modify: `personas/_staging_alpha/identity.yaml`
- Modify: `ops/local/runbook.md`

- [ ] **Step 1: Add child-reddit to `docker-compose.yml`**

```yaml
  child-reddit:
    build:
      context: .
      dockerfile: packages/child-reddit/Dockerfile
    image: social-manifold/child-reddit:dev
    restart: unless-stopped
    depends_on:
      - vault
    environment:
      CHILD_REDDIT_SOCKET_PATH: /run/social-manifold/children/reddit.sock
      VAULT_SOCKET_PATH: /run/social-manifold/vault.sock
    volumes:
      - /run/social-manifold:/run/social-manifold
```

- [ ] **Step 2: Enable reddit in the staging identity**

Edit `personas/_staging_alpha/identity.yaml`:
```yaml
platforms:
  discord:
    enabled: true
    credential_ref: discord_token
  reddit:
    enabled: false   # set true once you've populated reddit creds and a refresh token
    credential_ref: reddit_oauth
```

- [ ] **Step 3: Runbook additions**

Append to `ops/local/runbook.md`:

```markdown
### Reddit OAuth bootstrap (one-time, per persona)

Reddit's OAuth model requires a long-lived `refresh_token` obtained via a one-time user-flow redirect. This is a manual step per persona before that persona's reddit platform can be used.

1. Create a Reddit OAuth web app at https://www.reddit.com/prefs/apps. App type: "web app". Redirect URI: a URL you control (`http://localhost:8080/cb` works for the bootstrap).
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
8. Restart core and child-reddit.

### Audit log shift for OAuth-backed children

Reddit (and other OAuth platforms) refresh access_tokens roughly once per hour per persona. The vault's audit log records these refreshes — NOT every verb call. If you see fewer audit entries than verb calls, that is the OAuth child caching its access_token; per-action audit lives at the child level (deferred to the telemetry plan).

### Reddit ban-speed warning

Reddit will ban an unwarmed bot account faster than Discord will ban an unwarmed bot. Use a real human-warmed staging account before any production-ish testing. Do NOT use a fresh account.
```

- [ ] **Step 4: Build all images**

```bash
docker compose build
```

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml personas/_staging_alpha/identity.yaml ops/local/runbook.md
git commit -m "feat(ops): wire child-reddit into compose; document Reddit OAuth bootstrap"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run all tests**

`pnpm test` — every package passes.

- [ ] **Step 2: Build all images**

`docker compose build` — core + vault + child-discord + child-reddit all build.

- [ ] **Step 3: Self-review checklist**

- [ ] CLAUDE.md §5 amendment visible in the diff
- [ ] No `refresh_sentinel` value appears in any test response or log
- [ ] AccessTokenCache test asserts the `refresh_token` is consumed (Credential.use() contract holds for OAuth too)
- [ ] Cross-platform rate-limit isolation test exists and passes
- [ ] Integration test asserts the bot/refresh sentinel is absent from MCP response
- [ ] No special-casing per platform in core's verb logic — only the `pickChild()` switch

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin plan-5-child-reddit
gh pr create --title "Plan 5: child-reddit + OAuth refresh + content adapter generalization" --body "..."
```

PR body lists:
- Summary
- CLAUDE.md amendment A (§5)
- D1–D9 with reasoning
- Test plan
- Cross-platform isolation fix called out (the rate-limit-key bug from Plan 4)
- Deferred items (live integration, web-flow OAuth, reply_to_thread, etc.)
