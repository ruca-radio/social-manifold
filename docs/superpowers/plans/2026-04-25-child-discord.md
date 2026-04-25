# Child-Discord MCP + Vault Integration + Core Routing — Plan 3

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `@social-manifold/child-discord` as the manifold's first real platform child. Wire the core MCP's `post_to_community` verb to route `discord://...` community refs through the new child, which fetches the persona's bot token from the vault and posts to Discord via REST. This is the load-test for the `Credential` wrapper API.

**Architecture:** child-discord runs as its own service (HTTP server on the `manifold_core` Docker network). The core has an HTTP client per child, dispatches by URI scheme. child-discord pulls credentials per action via a vault HTTP client (over UDS), wraps them in `Credential`, and uses `.use(cb)` to call the Discord REST API inside a single scoped block. `Credential` consumption-on-`.use()` is preserved end-to-end.

```
HERMES → core MCP (post_to_community)
            │ parse community_ref
            │ "discord://..." → discord client
            ▼
         child-discord HTTP server
            │ ask vault for persona's discord creds
            ▼
         persona-vault (UDS) ──────► sops decrypt
            │ Credential wrapper
            │ .use(cb) → REST.post(channel, content)
            ▼
         Discord API
```

**Tech Stack:** Node 20, TypeScript 5, `@discordjs/rest` + `discord-api-types`, plain `node:http` (server + client), Vitest with mocked Discord at the boundary.

**Scope (covers §15 step 3 only):** child-discord with **one verb (`post-message`)**, wired into `post_to_community` via the core router, exercising the vault-client + Credential roundtrip. Other verbs (reply, engage, dm, monitor_mentions, enumerate_communities) are deferred. Idempotency ledger, rate-limit accountant, telemetry deferred to their own plans (§15 steps 4 and 6).

---

## Decisions surfaced

This is the first cross-service integration; several decisions are load-bearing for the rest of §15. Calling them out so they're locked in (or contested) before code lands.

### D1. Transport between core and children: plain HTTP-RPC, not MCP

The core uses MCP to talk to Hermes (the agentic boundary). Core ↔ child is internal RPC; MCP framing adds tool-discovery and capability negotiation we don't use internally. A child's "tools" are its HTTP routes; the core knows them at compile-time.

**Why this matters now:** the choice locks in the integration shape for telegram, reddit, matrix, etc. Picking HTTP-RPC keeps each child's interface explicit (TypeScript types shared via `@social-manifold/contracts` — to be created in this plan) and avoids the per-child MCP-server boilerplate.

**Reverse if:** a child legitimately needs to expose tools agentically (e.g., a debug/operator-facing console). Then it gets a parallel MCP listener; the internal RPC stays HTTP.

### D2. Discord library: `@discordjs/rest` only, no gateway

`post_to_community` needs only the Discord REST API. Adding the gateway pulls in `discord.js`'s long-lived `Client`, which holds the bot token in its own state for the lifetime of the connection — defeating Credential.use() consumption semantics.

**Reverse when:** we implement `monitor_mentions` or DM reception. At that point we need the gateway, and we accept that for stateful clients the Credential wrapper is "scoped at handoff" not "consumed for the bot's lifetime." Document the boundary in a `LiveSession` abstraction.

### D3. Credential lifecycle: per-action fetch, single-use consumption

Every action that needs the discord token calls vault → wraps response in `Credential` → enters `.use(cb)` → the REST client is built INSIDE the callback → the call is made → cred is consumed when the callback exits. Each action is one vault call, one audit entry, one network bot-token-in-flight window.

This is N vault calls per N actions. Cost: ~1 ms localhost UDS roundtrip + sops fork for decryption. Acceptable.

**Reverse if:** rate-limiter or mass-action volume makes per-call audit overhead measurable in the operator's mental model. Even then, the right answer is a TIME-BOUNDED in-process cache (e.g., 60-second TTL) that issues fresh `Credential` instances per use and re-fetches on miss — not caching the `Credential` object indefinitely.

### D4. Single shared types package: `packages/contracts`

Without a shared types package, the core and child-discord would either (a) duplicate types, or (b) cross-import from each other's `src/`, creating cyclical dependency risk. Creating a `@social-manifold/contracts` package now establishes the pattern for telegram/reddit/etc. and gives the vault-client a place to put its public API surface.

Initial contents: VerbResult shape, Discord post request/response, vault client interface.

### D5. Mocked Discord in tests; live integration deferred

`@discordjs/rest` is mocked at the boundary. We test:
- the adapter correctly translates Credential → REST call
- the child correctly translates HTTP request → adapter → HTTP response
- the core correctly routes `discord://` → child-discord
- the full chain end-to-end with mocked Discord and a REAL vault

Live Discord integration tests require a real staging Discord bot, a guild Patrick controls, and a bot token. That's operator setup, deferred until those exist. Documented in the runbook as a follow-up step.

### D6. URI parsing: plain regex per scheme; no URI library

`discord://guild:G/channel:C` is well-formed enough that `String.prototype.match(/^discord:\/\/guild:(\d+)\/channel:(\d+)$/)` is the right tool. Avoids a runtime dependency. The `route-by-uri.ts` module will accumulate one regex per platform; revisit if it ever exceeds 10 patterns.

---

## File structure

```
packages/
├── contracts/                  ← NEW (D4)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── verbs.ts            ← VerbResult, MediaRef, etc.
│       ├── discord.ts          ← post-message request/response
│       └── vault.ts            ← vault client interface (re-exports types)
│
├── core/                       ← MODIFIED
│   └── src/
│       ├── server.ts           ← unchanged registerTool wiring
│       ├── verbs/
│       │   └── post_to_community.ts   ← real routing (was: echo stub)
│       ├── router/
│       │   └── route-by-uri.ts        ← NEW — community_ref → child dispatch
│       └── child-clients/
│           └── discord.ts             ← NEW — HTTP client for child-discord
│
└── child-discord/              ← NEW
    ├── package.json
    ├── tsconfig.json
    ├── vitest.config.ts
    ├── Dockerfile
    └── src/
        ├── server.ts           ← HTTP server, routes /v1/post-message
        ├── adapter.ts          ← Credential → @discordjs/rest call
        └── deps.ts             ← injectable factories (for test seams)

services/persona-vault/src/client/
└── vault-client.ts             ← NEW — HTTP-over-UDS client; lives in vault package
                                  but exposed via the existing /client export

docker-compose.yml              ← MODIFIED — adds child-discord service
```

---

### Task 1: Shared contracts package

**Files:**
- Modify: `pnpm-workspace.yaml` (already includes `packages/*` — confirm)
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/verbs.ts`
- Create: `packages/contracts/src/discord.ts`

- [ ] **Step 1: Create `packages/contracts/package.json`**

```json
{
  "name": "@social-manifold/contracts",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 2: Create `packages/contracts/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `packages/contracts/src/verbs.ts`**

```typescript
export type VerbStatus = "ok" | "echoed" | "deduped" | "failed";

export interface VerbResult {
  status: VerbStatus;
  platform_response_id: string | null;
  idempotency_key: string;
  telemetry_span_id: string | null;
  warnings: string[];
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

- [ ] **Step 4: Create `packages/contracts/src/discord.ts`**

```typescript
export interface DiscordPostMessageRequest {
  persona_id: string;
  guild_id: string;
  channel_id: string;
  content: string;
  idempotency_key: string;
}

export interface DiscordPostMessageResponse {
  message_id: string;
  channel_id: string;
}

export interface DiscordPostMessageError {
  error: string;
  detail?: string;
}
```

- [ ] **Step 5: Create `packages/contracts/src/index.ts`**

```typescript
export * from "./verbs.js";
export * from "./discord.js";
```

- [ ] **Step 6: Install + build**

Run: `pnpm install && pnpm --filter @social-manifold/contracts build`
Expected: `packages/contracts/dist/` populated.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(contracts): add shared types package for cross-service contracts"
```

---

### Task 2: Vault HTTP client (in vault package)

**Files:**
- Create: `services/persona-vault/src/client/vault-client.ts`
- Create: `services/persona-vault/tests/vault-client.test.ts`
- Modify: `services/persona-vault/package.json` (export `./client` already present — confirm includes vault-client)

The vault client is a thin wrapper over `node:http.request({ socketPath })` that returns `Credential` instances directly.

- [ ] **Step 1: Write the failing test**

Path: `services/persona-vault/tests/vault-client.test.ts`
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createVaultServer } from "../src/server.js";
import { VaultClient } from "../src/client/vault-client.js";
import { Credential } from "../src/client/credential.js";

const exec = promisify(execFile);

interface Rig {
  socket: string;
  server: Server;
  secret: string;
}

async function setup(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), "vc-"));
  const personasRoot = join(tmp, "personas");
  await mkdir(join(personasRoot, "p1"), { recursive: true });
  await writeFile(
    join(personasRoot, "p1", "identity.yaml"),
    `id: p1
display_name: "p1"
type: branded_bot
timezone: UTC
locale: en-US
working_hours: "00:00-23:59"
posting_cadence_minutes: [1, 3]
proxy_pool: none
disclosed_automation: true
platforms:
  discord:
    enabled: true
    credential_ref: discord_token
`,
    "utf8",
  );
  const ageDir = await mkdtemp(join(tmpdir(), "vc-age-"));
  const ageKey = join(ageDir, "k");
  await exec("age-keygen", ["-o", ageKey]);
  await chmod(ageKey, 0o400);
  const recipient = (await readFile(ageKey, "utf8")).match(
    /# public key: (age1[a-z0-9]+)/i,
  )![1];

  const SECRET = "VC-SENTINEL-MN3K";
  const credPath = join(personasRoot, "p1", "credentials.sops.yaml");
  await writeFile(
    credPath,
    `discord:\n  bot_token: ${SECRET}\n`,
    "utf8",
  );
  await exec("sops", ["--encrypt", "--age", recipient, "--in-place", credPath]);

  const socket = join(tmp, "v.sock");
  const server = await createVaultServer({
    personasRoot,
    auditPath: join(tmp, "audit.jsonl"),
    ageKeyPath: ageKey,
    socketPath: socket,
  });
  return { socket, server, secret: SECRET };
}

describe("VaultClient", () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await setup();
  });
  afterAll(async () => {
    await new Promise<void>((r) => rig.server.close(() => r()));
  });

  it("listPersonas() returns persona IDs", async () => {
    const c = new VaultClient(rig.socket);
    expect(await c.listPersonas()).toEqual(["p1"]);
  });

  it("listPlatforms() returns enabled platform names only", async () => {
    const c = new VaultClient(rig.socket);
    expect(await c.listPlatforms("p1")).toEqual(["discord"]);
  });

  it("getCredential() returns a Credential wrapping the platform creds", async () => {
    const c = new VaultClient(rig.socket);
    const cred = await c.getCredential("p1", "discord", {
      requester_id: "test",
      purpose: "vault-client-test",
    });
    expect(cred).toBeInstanceOf(Credential);
    expect(cred.get("bot_token")).toBe(rig.secret);
  });

  it("getCredential() returns a redacting Credential (toJSON guard)", async () => {
    const c = new VaultClient(rig.socket);
    const cred = await c.getCredential("p1", "discord", {
      requester_id: "t",
      purpose: "p",
    });
    expect(JSON.stringify(cred)).toBe('"[Credential redacted]"');
  });

  it("getCredential() throws on unknown persona", async () => {
    const c = new VaultClient(rig.socket);
    await expect(
      c.getCredential("ghost", "discord", { requester_id: "t", purpose: "p" }),
    ).rejects.toThrow();
  });

  it("getCredential() throws when requester_id is empty", async () => {
    const c = new VaultClient(rig.socket);
    await expect(
      c.getCredential("p1", "discord", { requester_id: "", purpose: "x" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/persona-vault test`
Expected: FAIL — `vault-client.js` not found.

- [ ] **Step 3: Implement**

Path: `services/persona-vault/src/client/vault-client.ts`
```typescript
import { request } from "node:http";
import { Credential } from "./credential.js";

export interface CredentialRequest {
  requester_id: string;
  purpose: string;
}

interface RawResponse {
  status: number;
  body: unknown;
}

function uds(
  socketPath: string,
  method: string,
  path: string,
  body?: object,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: body ? { "content-type": "application/json" } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export class VaultClient {
  constructor(private readonly socketPath: string) {}

  async listPersonas(): Promise<string[]> {
    const res = await uds(this.socketPath, "GET", "/v1/personas");
    if (res.status !== 200) {
      throw new Error(`vault listPersonas failed: ${res.status}`);
    }
    return (res.body as { personas: string[] }).personas;
  }

  async listPlatforms(personaId: string): Promise<string[]> {
    const res = await uds(
      this.socketPath,
      "GET",
      `/v1/personas/${encodeURIComponent(personaId)}/platforms`,
    );
    if (res.status !== 200) {
      throw new Error(
        `vault listPlatforms failed for ${personaId}: ${res.status}`,
      );
    }
    return (res.body as { platforms: string[] }).platforms;
  }

  async getCredential(
    personaId: string,
    platform: string,
    request: CredentialRequest,
  ): Promise<Credential> {
    if (!request.requester_id || !request.purpose) {
      throw new Error("vault.getCredential: requester_id and purpose required");
    }
    const res = await uds(
      this.socketPath,
      "POST",
      `/v1/personas/${encodeURIComponent(personaId)}/credentials/${encodeURIComponent(platform)}`,
      request,
    );
    if (res.status !== 200) {
      const detail =
        res.body && typeof res.body === "object" && "error" in res.body
          ? (res.body as { error: string }).error
          : String(res.status);
      throw new Error(
        `vault.getCredential(${personaId}, ${platform}): ${detail}`,
      );
    }
    const payload = res.body as { credential: Record<string, string> };
    return new Credential(payload.credential);
  }
}
```

- [ ] **Step 4: Update `services/persona-vault/package.json` exports**

Find:
```json
"exports": {
  ".": "./dist/server.js",
  "./client": "./dist/client/credential.js"
}
```
Replace with:
```json
"exports": {
  ".": "./dist/server.js",
  "./client": "./dist/client/index.js"
}
```

And create `services/persona-vault/src/client/index.ts`:
```typescript
export { Credential } from "./credential.js";
export { VaultClient } from "./vault-client.js";
export type { CredentialRequest } from "./vault-client.js";
```

- [ ] **Step 5: Run, expect PASS**

Run: `pnpm --filter @social-manifold/persona-vault test`
Expected: all tests pass; vault-client adds 6.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(vault): add VaultClient (HTTP-over-UDS) returning Credential instances"
```

---

### Task 3: child-discord package skeleton + Discord adapter (TDD with mocked REST)

**Files:**
- Create: `packages/child-discord/package.json`
- Create: `packages/child-discord/tsconfig.json`
- Create: `packages/child-discord/vitest.config.ts`
- Create: `packages/child-discord/src/deps.ts`
- Create: `packages/child-discord/tests/adapter.test.ts`
- Create: `packages/child-discord/src/adapter.ts`

- [ ] **Step 1: Create `packages/child-discord/package.json`**

```json
{
  "name": "@social-manifold/child-discord",
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
    "@discordjs/rest": "^2.4.0",
    "discord-api-types": "^0.37.110",
    "@social-manifold/contracts": "workspace:*",
    "@social-manifold/persona-vault": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `packages/child-discord/tsconfig.json`**

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

- [ ] **Step 3: Create `packages/child-discord/vitest.config.ts`**

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

- [ ] **Step 4: Create `packages/child-discord/src/deps.ts`** — injectable seams for tests

```typescript
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";

export interface DiscordRestPort {
  postMessage(
    channelId: string,
    content: string,
    token: string,
  ): Promise<{ id: string }>;
}

/**
 * Production REST adapter — builds a fresh @discordjs/rest client per call,
 * sets the bot token, makes the request, then drops the reference. Cred is
 * passed as a string here because we're already inside the Credential.use()
 * callback at the call site.
 */
export const liveDiscordRest: DiscordRestPort = {
  async postMessage(channelId, content, token) {
    const rest = new REST({ version: "10" }).setToken(token);
    const result = (await rest.post(Routes.channelMessages(channelId), {
      body: { content },
    })) as { id: string };
    return { id: result.id };
  },
};
```

- [ ] **Step 5: Write failing adapter test**

Path: `packages/child-discord/tests/adapter.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { Credential } from "@social-manifold/persona-vault/client";
import { postMessage } from "../src/adapter.js";
import type { DiscordRestPort } from "../src/deps.js";

function fakeRest(spy: { calls: any[] }): DiscordRestPort {
  return {
    async postMessage(channelId, content, token) {
      spy.calls.push({ channelId, content, token });
      return { id: "msg-12345" };
    },
  };
}

describe("postMessage adapter", () => {
  it("calls REST inside .use() with the decrypted token", async () => {
    const cred = new Credential({ bot_token: "BOT-TOKEN-XYZ" });
    const spy: { calls: any[] } = { calls: [] };
    const result = await postMessage(cred, fakeRest(spy), {
      channel_id: "ch1",
      content: "hello",
    });

    expect(result.message_id).toBe("msg-12345");
    expect(result.channel_id).toBe("ch1");
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].token).toBe("BOT-TOKEN-XYZ");
    expect(spy.calls[0].channelId).toBe("ch1");
    expect(spy.calls[0].content).toBe("hello");
  });

  it("consumes the credential after the call (Credential.use() contract)", async () => {
    const cred = new Credential({ bot_token: "BOT-TOKEN-XYZ" });
    const spy: { calls: any[] } = { calls: [] };
    await postMessage(cred, fakeRest(spy), {
      channel_id: "ch1",
      content: "hi",
    });

    // After successful action the credential must be consumed.
    expect(cred.get("bot_token")).toBeUndefined();
    await expect(
      postMessage(cred, fakeRest(spy), { channel_id: "ch1", content: "hi" }),
    ).rejects.toThrow(/already consumed/);
  });

  it("consumes the credential even when REST throws", async () => {
    const cred = new Credential({ bot_token: "BOT-TOKEN-XYZ" });
    const failingRest: DiscordRestPort = {
      async postMessage() {
        throw new Error("discord 503");
      },
    };

    await expect(
      postMessage(cred, failingRest, { channel_id: "ch1", content: "x" }),
    ).rejects.toThrow(/discord 503/);

    expect(cred.get("bot_token")).toBeUndefined();
  });

  it("throws when the credential lacks a bot_token", async () => {
    const cred = new Credential({ application_id: "111" });
    const spy: { calls: any[] } = { calls: [] };
    await expect(
      postMessage(cred, fakeRest(spy), { channel_id: "ch1", content: "x" }),
    ).rejects.toThrow(/bot_token/);
    expect(spy.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/child-discord test`
Expected: FAIL — `adapter.js` not found.

- [ ] **Step 7: Implement adapter**

Path: `packages/child-discord/src/adapter.ts`
```typescript
import type { Credential } from "@social-manifold/persona-vault/client";
import type {
  DiscordPostMessageResponse,
} from "@social-manifold/contracts";
import type { DiscordRestPort } from "./deps.js";

export interface PostMessageInput {
  channel_id: string;
  content: string;
}

/**
 * Post a message to a Discord channel.
 *
 * Credential lifecycle: the bot token is held within Credential.use() for
 * exactly the duration of the REST call, then actively cleared (see
 * services/persona-vault/src/client/credential.ts). If the REST call throws,
 * the credential is still cleared via the .use() finally block. There is
 * no path here that holds the token outside the .use() scope.
 */
export async function postMessage(
  cred: Credential,
  rest: DiscordRestPort,
  input: PostMessageInput,
): Promise<DiscordPostMessageResponse> {
  return cred.use(async (raw) => {
    const token = raw.bot_token;
    if (!token) {
      throw new Error(
        "discord adapter: credential bundle is missing 'bot_token'",
      );
    }
    const { id } = await rest.postMessage(input.channel_id, input.content, token);
    return { message_id: id, channel_id: input.channel_id };
  });
}
```

- [ ] **Step 8: Install + run, expect PASS**

Run: `pnpm install && pnpm --filter @social-manifold/child-discord test`
Expected: 4 adapter tests pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(child-discord): add Discord REST adapter with Credential consumption"
```

---

### Task 4: child-discord HTTP server

**Files:**
- Create: `packages/child-discord/src/server.ts`
- Create: `packages/child-discord/tests/server.test.ts`

The server is a thin HTTP front-end: receive `POST /v1/post-message`, fetch the credential from the vault, call the adapter, return the response.

- [ ] **Step 1: Write the failing integration test**

Path: `packages/child-discord/tests/server.test.ts`
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { Server as HttpServer } from "node:http";
import { createVaultServer } from "@social-manifold/persona-vault";
import { VaultClient } from "@social-manifold/persona-vault/client";
import type { Server } from "node:http";
import { createChildDiscordServer } from "../src/server.js";
import type { DiscordRestPort } from "../src/deps.js";

const exec = promisify(execFile);

interface Rig {
  childPort: number;
  vaultServer: Server;
  childServer: Server;
  restCalls: any[];
  bot_token_sentinel: string;
}

function tcpReq(
  port: number,
  method: string,
  path: string,
  body?: object,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: body ? { "content-type": "application/json" } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: any = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function setupRig(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), "cd-"));
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
  discord:
    enabled: true
    credential_ref: discord_token
`,
    "utf8",
  );
  const ageDir = await mkdtemp(join(tmpdir(), "cd-age-"));
  const ageKey = join(ageDir, "k");
  await exec("age-keygen", ["-o", ageKey]);
  await chmod(ageKey, 0o400);
  const recipient = (await readFile(ageKey, "utf8")).match(
    /# public key: (age1[a-z0-9]+)/i,
  )![1];
  const SENTINEL = "BOT-SENTINEL-VR2P";
  const credPath = join(personasRoot, "p_alpha", "credentials.sops.yaml");
  await writeFile(
    credPath,
    `discord:\n  bot_token: ${SENTINEL}\n`,
    "utf8",
  );
  await exec("sops", ["--encrypt", "--age", recipient, "--in-place", credPath]);

  const socketPath = join(tmp, "v.sock");
  const vaultServer = await createVaultServer({
    personasRoot,
    auditPath: join(tmp, "audit.jsonl"),
    ageKeyPath: ageKey,
    socketPath,
  });

  const restCalls: any[] = [];
  const fakeRest: DiscordRestPort = {
    async postMessage(channelId, content, token) {
      restCalls.push({ channelId, content, token });
      return { id: "fake-message-id-42" };
    },
  };

  const vault = new VaultClient(socketPath);
  const childServer = await createChildDiscordServer({
    port: 0, // ephemeral
    vault,
    rest: fakeRest,
  });
  const addr = childServer.address();
  const childPort =
    addr && typeof addr === "object" ? (addr as { port: number }).port : 0;
  return {
    childPort,
    vaultServer,
    childServer,
    restCalls,
    bot_token_sentinel: SENTINEL,
  };
}

describe("child-discord HTTP server", () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await setupRig();
  });
  afterAll(async () => {
    await new Promise<void>((r) => rig.childServer.close(() => r()));
    await new Promise<void>((r) => rig.vaultServer.close(() => r()));
  });

  it("POST /v1/post-message fetches creds from vault and calls REST", async () => {
    const res = await tcpReq(rig.childPort, "POST", "/v1/post-message", {
      persona_id: "p_alpha",
      guild_id: "g1",
      channel_id: "c1",
      content: "hello discord",
      idempotency_key: "ik-1",
    });
    expect(res.status).toBe(200);
    expect(res.body.message_id).toBe("fake-message-id-42");
    expect(res.body.channel_id).toBe("c1");

    expect(rig.restCalls).toHaveLength(1);
    expect(rig.restCalls[0].token).toBe(rig.bot_token_sentinel);
    expect(rig.restCalls[0].channelId).toBe("c1");
    expect(rig.restCalls[0].content).toBe("hello discord");
  });

  it("never echoes the bot token in any HTTP response", async () => {
    const res = await tcpReq(rig.childPort, "POST", "/v1/post-message", {
      persona_id: "p_alpha",
      guild_id: "g1",
      channel_id: "c1",
      content: "x",
      idempotency_key: "ik-2",
    });
    expect(JSON.stringify(res.body)).not.toContain(rig.bot_token_sentinel);
  });

  it("returns 404 for an unknown persona", async () => {
    const res = await tcpReq(rig.childPort, "POST", "/v1/post-message", {
      persona_id: "ghost",
      guild_id: "g",
      channel_id: "c",
      content: "x",
      idempotency_key: "ik-3",
    });
    expect(res.status).toBe(404);
    // error message must not echo the request body unfiltered
    expect(JSON.stringify(res.body)).not.toContain(rig.bot_token_sentinel);
  });

  it("returns 400 on missing required fields", async () => {
    const res = await tcpReq(rig.childPort, "POST", "/v1/post-message", {
      persona_id: "p_alpha",
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/child-discord test`
Expected: FAIL — server module missing.

- [ ] **Step 3: Implement the server**

Path: `packages/child-discord/src/server.ts`
```typescript
import {
  createServer as createHttpServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import { VaultClient } from "@social-manifold/persona-vault/client";
import type {
  DiscordPostMessageRequest,
  DiscordPostMessageResponse,
} from "@social-manifold/contracts";
import { liveDiscordRest, type DiscordRestPort } from "./deps.js";
import { postMessage } from "./adapter.js";

export interface ChildDiscordConfig {
  port: number;
  vault: VaultClient;
  rest: DiscordRestPort;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function handlePostMessage(
  req: IncomingMessage,
  res: ServerResponse,
  vault: VaultClient,
  rest: DiscordRestPort,
): Promise<void> {
  const body = (await readJsonBody(req)) as Partial<DiscordPostMessageRequest> | null;
  if (
    !body ||
    typeof body.persona_id !== "string" ||
    typeof body.channel_id !== "string" ||
    typeof body.content !== "string" ||
    typeof body.idempotency_key !== "string"
  ) {
    send(res, 400, { error: "missing required fields" });
    return;
  }

  let cred;
  try {
    cred = await vault.getCredential(body.persona_id, "discord", {
      requester_id: "child-discord",
      purpose: `post-message:${body.idempotency_key}`,
    });
  } catch (err) {
    send(res, 404, { error: "credential not available", detail: (err as Error).message });
    return;
  }

  try {
    const result: DiscordPostMessageResponse = await postMessage(cred, rest, {
      channel_id: body.channel_id,
      content: body.content,
    });
    send(res, 200, result);
  } catch (err) {
    send(res, 502, { error: "discord call failed", detail: (err as Error).message });
  }
}

function route(vault: VaultClient, rest: DiscordRestPort) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method === "POST" && req.url === "/v1/post-message") {
        return handlePostMessage(req, res, vault, rest);
      }
      send(res, 404, { error: "not found" });
    } catch {
      send(res, 500, { error: "internal" });
    }
  };
}

export async function createChildDiscordServer(
  config: ChildDiscordConfig,
): Promise<Server> {
  const server = createHttpServer(route(config.vault, config.rest));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.CHILD_DISCORD_PORT ?? "7811");
  const vaultSocket =
    process.env.VAULT_SOCKET_PATH ?? "/run/social-manifold/vault.sock";

  const { existsSync } = await import("node:fs");
  if (!existsSync(vaultSocket)) {
    console.error(
      `child-discord: vault socket ${vaultSocket} does not exist. Is the vault running?`,
    );
    process.exit(1);
  }
  const vault = new VaultClient(vaultSocket);
  await createChildDiscordServer({ port, vault, rest: liveDiscordRest });
  console.error(`child-discord: listening on :${port}`);
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @social-manifold/child-discord test`
Expected: 4 server tests pass + 4 adapter tests = 8.

- [ ] **Step 5: Build**

Run: `pnpm --filter @social-manifold/child-discord build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(child-discord): add HTTP server wiring vault + adapter"
```

---

### Task 5: Core router + child-discord HTTP client (TDD)

**Files:**
- Create: `packages/core/src/router/route-by-uri.ts`
- Create: `packages/core/src/child-clients/discord.ts`
- Create: `packages/core/tests/route-by-uri.test.ts`
- Modify: `packages/core/package.json` (add `@social-manifold/contracts` dep)

- [ ] **Step 1: Add contracts dep to core**

Edit `packages/core/package.json` `dependencies`:
```json
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.0.4",
  "@social-manifold/contracts": "workspace:*",
  "zod": "^3.23.8"
}
```

Run: `pnpm install`

- [ ] **Step 2: Write failing test for route-by-uri**

Path: `packages/core/tests/route-by-uri.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { parseCommunityRef } from "../src/router/route-by-uri.js";

describe("parseCommunityRef", () => {
  it("parses a valid discord channel ref", () => {
    const r = parseCommunityRef("discord://guild:123/channel:456");
    expect(r).toEqual({
      platform: "discord",
      guild_id: "123",
      channel_id: "456",
    });
  });

  it("returns null for unknown schemes", () => {
    expect(parseCommunityRef("twitter://user/foo")).toBeNull();
    expect(parseCommunityRef("not-a-uri")).toBeNull();
    expect(parseCommunityRef("")).toBeNull();
  });

  it("returns null for malformed discord refs", () => {
    expect(parseCommunityRef("discord://guild:123")).toBeNull();
    expect(parseCommunityRef("discord://channel:456")).toBeNull();
    expect(parseCommunityRef("discord://guild:abc/channel:def")).toBeNull();
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/core test`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement parser**

Path: `packages/core/src/router/route-by-uri.ts`
```typescript
export interface DiscordCommunityRef {
  platform: "discord";
  guild_id: string;
  channel_id: string;
}

export type CommunityRef = DiscordCommunityRef;

const DISCORD = /^discord:\/\/guild:(\d+)\/channel:(\d+)$/;

export function parseCommunityRef(ref: string): CommunityRef | null {
  const m = ref.match(DISCORD);
  if (m) {
    return { platform: "discord", guild_id: m[1], channel_id: m[2] };
  }
  return null;
}
```

- [ ] **Step 5: Implement child-discord HTTP client**

Path: `packages/core/src/child-clients/discord.ts`
```typescript
import { request } from "node:http";
import type {
  DiscordPostMessageRequest,
  DiscordPostMessageResponse,
} from "@social-manifold/contracts";

export interface DiscordChildClientConfig {
  host: string;
  port: number;
}

interface RawResponse {
  status: number;
  body: unknown;
}

function tcp(
  cfg: DiscordChildClientConfig,
  method: string,
  path: string,
  body?: object,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: cfg.host,
        port: cfg.port,
        method,
        path,
        headers: body ? { "content-type": "application/json" } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export class DiscordChildClient {
  constructor(private readonly cfg: DiscordChildClientConfig) {}

  async postMessage(
    payload: DiscordPostMessageRequest,
  ): Promise<DiscordPostMessageResponse> {
    const res = await tcp(this.cfg, "POST", "/v1/post-message", payload);
    if (res.status !== 200) {
      const detail =
        res.body && typeof res.body === "object" && "error" in res.body
          ? (res.body as { error: string }).error
          : String(res.status);
      throw new Error(`child-discord post-message failed: ${detail}`);
    }
    return res.body as DiscordPostMessageResponse;
  }
}
```

- [ ] **Step 6: Run, expect PASS**

Run: `pnpm --filter @social-manifold/core test`
Expected: route-by-uri tests pass + existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): add URI router and child-discord HTTP client"
```

---

### Task 6: Wire post_to_community to actually route

**Files:**
- Modify: `packages/core/src/types.ts` (drop — types now live in contracts)
- Modify: `packages/core/src/verbs/post_to_community.ts`
- Modify: `packages/core/src/server.ts`
- Modify: `packages/core/tests/post_to_community.test.ts`
- Modify: `packages/core/tests/server.test.ts`

The verb gains a router dependency and produces a real `VerbResult` with the Discord message ID. Tests are rewritten — the echo behavior is gone.

- [ ] **Step 1: Replace `packages/core/src/types.ts`** — re-export from contracts

```typescript
export type {
  VerbResult,
  VerbStatus,
  MediaRef,
  PostToCommunityInput,
} from "@social-manifold/contracts";
```

- [ ] **Step 2: Rewrite `packages/core/src/verbs/post_to_community.ts`**

```typescript
import { randomUUID } from "node:crypto";
import type { PostToCommunityInput, VerbResult } from "@social-manifold/contracts";
import { parseCommunityRef } from "../router/route-by-uri.js";
import { DiscordChildClient } from "../child-clients/discord.js";

export interface PostToCommunityDeps {
  discord: DiscordChildClient;
}

export async function postToCommunity(
  input: PostToCommunityInput,
  deps: PostToCommunityDeps,
): Promise<VerbResult> {
  const idempotencyKey = input.idempotency_key ?? randomUUID();
  const ref = parseCommunityRef(input.community_ref);

  if (!ref) {
    return {
      status: "failed",
      platform_response_id: null,
      idempotency_key: idempotencyKey,
      telemetry_span_id: null,
      warnings: [
        `unrecognized community_ref scheme: ${input.community_ref}`,
      ],
    };
  }

  if (ref.platform === "discord") {
    try {
      const result = await deps.discord.postMessage({
        persona_id: input.persona_id,
        guild_id: ref.guild_id,
        channel_id: ref.channel_id,
        content: input.content,
        idempotency_key: idempotencyKey,
      });
      return {
        status: "ok",
        platform_response_id: result.message_id,
        idempotency_key: idempotencyKey,
        telemetry_span_id: null,
        warnings: [],
      };
    } catch (err) {
      return {
        status: "failed",
        platform_response_id: null,
        idempotency_key: idempotencyKey,
        telemetry_span_id: null,
        warnings: [(err as Error).message],
      };
    }
  }

  return {
    status: "failed",
    platform_response_id: null,
    idempotency_key: idempotencyKey,
    telemetry_span_id: null,
    warnings: [`unsupported platform: ${(ref as { platform: string }).platform}`],
  };
}
```

- [ ] **Step 3: Update `packages/core/src/server.ts`**

Replace its body with:
```typescript
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DiscordChildClient } from "./child-clients/discord.js";
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
      const result = await postToCommunity(args, { discord: opts.discord });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const discordHost = process.env.CHILD_DISCORD_HOST ?? "child-discord";
  const discordPort = Number(process.env.CHILD_DISCORD_PORT ?? "7811");
  const discord = new DiscordChildClient({ host: discordHost, port: discordPort });

  const server = createServer({ discord });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 4: Rewrite `packages/core/tests/post_to_community.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { postToCommunity } from "../src/verbs/post_to_community.js";
import type { DiscordChildClient } from "../src/child-clients/discord.js";

function fakeDiscord(spy: { calls: any[]; result?: any; throws?: Error }): DiscordChildClient {
  return {
    postMessage: async (payload: any) => {
      spy.calls.push(payload);
      if (spy.throws) throw spy.throws;
      return spy.result ?? { message_id: "msg-1", channel_id: payload.channel_id };
    },
  } as unknown as DiscordChildClient;
}

describe("postToCommunity", () => {
  it("routes a discord:// ref to the discord child and returns ok status", async () => {
    const spy: { calls: any[] } = { calls: [] };
    const result = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "hi",
        idempotency_key: "k1",
      },
      { discord: fakeDiscord(spy) },
    );

    expect(result.status).toBe("ok");
    expect(result.platform_response_id).toBe("msg-1");
    expect(result.idempotency_key).toBe("k1");
    expect(result.warnings).toEqual([]);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].guild_id).toBe("111");
    expect(spy.calls[0].channel_id).toBe("222");
    expect(spy.calls[0].content).toBe("hi");
    expect(spy.calls[0].idempotency_key).toBe("k1");
  });

  it("generates an idempotency_key when none is supplied", async () => {
    const spy: { calls: any[] } = { calls: [] };
    const result = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "hi",
      },
      { discord: fakeDiscord(spy) },
    );
    expect(result.idempotency_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("returns failed status with a warning for unrecognized schemes", async () => {
    const spy: { calls: any[] } = { calls: [] };
    const result = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "twitter://user/foo",
        content: "hi",
        idempotency_key: "k1",
      },
      { discord: fakeDiscord(spy) },
    );
    expect(result.status).toBe("failed");
    expect(result.platform_response_id).toBeNull();
    expect(result.warnings[0]).toContain("unrecognized community_ref");
    expect(spy.calls).toEqual([]);
  });

  it("returns failed status when the child throws", async () => {
    const spy: { calls: any[]; throws?: Error } = {
      calls: [],
      throws: new Error("discord 503"),
    };
    const result = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "hi",
        idempotency_key: "k1",
      },
      { discord: fakeDiscord(spy) },
    );
    expect(result.status).toBe("failed");
    expect(result.platform_response_id).toBeNull();
    expect(result.warnings[0]).toContain("discord 503");
  });
});
```

- [ ] **Step 5: Update `packages/core/tests/server.test.ts`**

The MCP server test now needs a fake DiscordChildClient. Replace contents with:

```typescript
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { DiscordChildClient } from "../src/child-clients/discord.js";

const fakeDiscord = {
  postMessage: async () => ({ message_id: "fake-msg-9", channel_id: "c1" }),
} as unknown as DiscordChildClient;

describe("MCP server", () => {
  it("lists post_to_community as a tool and dispatches discord refs", async () => {
    const server = createServer({ discord: fakeDiscord });
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
    const textBlock = (callResult.content as { type: string; text: string }[])[0];
    const payload = JSON.parse(textBlock.text);
    expect(payload.status).toBe("ok");
    expect(payload.platform_response_id).toBe("fake-msg-9");
    expect(payload.idempotency_key).toBe("k1");

    await client.close();
    await server.close();
  });
});
```

- [ ] **Step 6: Build contracts so core can resolve them**

Run: `pnpm --filter @social-manifold/contracts build`

- [ ] **Step 7: Run all tests**

Run: `pnpm test`
Expected: every package's tests pass. Core tests now drive a fake discord client.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): wire post_to_community to route via discord child"
```

---

### Task 7: Full chain integration test (real vault, mocked Discord)

**Files:**
- Create: `packages/core/tests/integration.test.ts`

The single richest test: spins up a real persona-vault server (with sops/age) AND a real child-discord HTTP server (with mocked `@discordjs/rest`), points the core's DiscordChildClient at it, calls `post_to_community` via an in-process MCP client, and asserts the full pipeline.

- [ ] **Step 1: Write the test**

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
import { createChildDiscordServer } from "@social-manifold/child-discord/dist/server.js";
import type { DiscordRestPort } from "@social-manifold/child-discord/dist/deps.js";
import { createServer } from "../src/server.js";
import { DiscordChildClient } from "../src/child-clients/discord.js";

const exec = promisify(execFile);

interface Rig {
  vault: Server;
  child: Server;
  childPort: number;
  restCalls: any[];
  bot_token_sentinel: string;
}

async function setup(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), "int-"));
  const personasRoot = join(tmp, "personas");
  await mkdir(join(personasRoot, "p_e2e"), { recursive: true });
  await writeFile(
    join(personasRoot, "p_e2e", "identity.yaml"),
    `id: p_e2e
display_name: "p_e2e"
type: branded_bot
timezone: UTC
locale: en-US
working_hours: "00:00-23:59"
posting_cadence_minutes: [1, 3]
proxy_pool: none
disclosed_automation: true
platforms:
  discord:
    enabled: true
    credential_ref: discord_token
`,
    "utf8",
  );

  const ageDir = await mkdtemp(join(tmpdir(), "int-age-"));
  const ageKey = join(ageDir, "k");
  await exec("age-keygen", ["-o", ageKey]);
  await chmod(ageKey, 0o400);
  const recipient = (await readFile(ageKey, "utf8")).match(
    /# public key: (age1[a-z0-9]+)/i,
  )![1];
  const SENTINEL = "INT-BOT-SENTINEL-WX5T";
  const credPath = join(personasRoot, "p_e2e", "credentials.sops.yaml");
  await writeFile(credPath, `discord:\n  bot_token: ${SENTINEL}\n`, "utf8");
  await exec("sops", ["--encrypt", "--age", recipient, "--in-place", credPath]);

  const socket = join(tmp, "v.sock");
  const vault = await createVaultServer({
    personasRoot,
    auditPath: join(tmp, "audit.jsonl"),
    ageKeyPath: ageKey,
    socketPath: socket,
  });

  const restCalls: any[] = [];
  const fakeRest: DiscordRestPort = {
    async postMessage(channelId, content, token) {
      restCalls.push({ channelId, content, token });
      return { id: "e2e-msg-id" };
    },
  };
  const vaultClient = new VaultClient(socket);
  const child = await createChildDiscordServer({
    port: 0,
    vault: vaultClient,
    rest: fakeRest,
  });
  const addr = child.address();
  const childPort =
    addr && typeof addr === "object" ? (addr as { port: number }).port : 0;

  return { vault, child, childPort, restCalls, bot_token_sentinel: SENTINEL };
}

describe("integration: HERMES → core → child-discord → vault → discord", () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await setup();
  });
  afterAll(async () => {
    await new Promise<void>((r) => rig.child.close(() => r()));
    await new Promise<void>((r) => rig.vault.close(() => r()));
  });

  it("post_to_community(discord) traverses the full chain end-to-end", async () => {
    const discord = new DiscordChildClient({ host: "127.0.0.1", port: rig.childPort });
    const server = createServer({ discord });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: "int-test", version: "0.0.1" });
    await mcpClient.connect(clientTransport);

    const callResult = await mcpClient.callTool({
      name: "post_to_community",
      arguments: {
        persona_id: "p_e2e",
        community_ref: "discord://guild:111/channel:222",
        content: "end-to-end-hello",
        idempotency_key: "ik-int",
      },
    });
    const payload = JSON.parse((callResult.content as any[])[0].text);

    expect(payload.status).toBe("ok");
    expect(payload.platform_response_id).toBe("e2e-msg-id");
    expect(payload.idempotency_key).toBe("ik-int");
    // The MCP response must NOT contain the bot token anywhere.
    expect(JSON.stringify(payload)).not.toContain(rig.bot_token_sentinel);

    // The mocked Discord REST received the real decrypted token.
    expect(rig.restCalls).toHaveLength(1);
    expect(rig.restCalls[0].token).toBe(rig.bot_token_sentinel);
    expect(rig.restCalls[0].content).toBe("end-to-end-hello");

    await mcpClient.close();
    await server.close();
  });
});
```

- [ ] **Step 2: The test imports built JS from child-discord and persona-vault**

Run a build first:
```bash
pnpm --filter @social-manifold/contracts build
pnpm --filter @social-manifold/persona-vault build
pnpm --filter @social-manifold/child-discord build
```

- [ ] **Step 3: Run the integration test**

Run: `pnpm --filter @social-manifold/core test`
Expected: integration test passes; total core tests = unit + integration.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(core): add full-chain integration test (vault + child-discord + mocked discord)"
```

---

### Task 8: docker-compose wiring

**Files:**
- Create: `packages/child-discord/Dockerfile`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Create `packages/child-discord/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json pnpm-lock.yaml ./
COPY packages/contracts/package.json ./packages/contracts/
COPY services/persona-vault/package.json ./services/persona-vault/
COPY packages/child-discord/package.json ./packages/child-discord/
RUN pnpm install --filter @social-manifold/child-discord... --frozen-lockfile
COPY packages/contracts ./packages/contracts
COPY services/persona-vault ./services/persona-vault
COPY packages/child-discord ./packages/child-discord
RUN pnpm --filter @social-manifold/child-discord build
RUN pnpm --filter @social-manifold/child-discord deploy --prod /out

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
ENV NODE_ENV=production
ENV CHILD_DISCORD_PORT=7811
ENV VAULT_SOCKET_PATH=/run/social-manifold/vault.sock
EXPOSE 7811
CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Add child-discord to `docker-compose.yml`**

Add after the `vault` service block:

```yaml
  child-discord:
    build:
      context: .
      dockerfile: packages/child-discord/Dockerfile
    image: social-manifold/child-discord:dev
    restart: unless-stopped
    networks:
      - manifold_core
    depends_on:
      - vault
    environment:
      CHILD_DISCORD_PORT: "7811"
      VAULT_SOCKET_PATH: /run/social-manifold/vault.sock
    volumes:
      # vault socket — same canonical mount as `vault` service
      - /run/social-manifold:/run/social-manifold
```

- [ ] **Step 3: Build images**

Run: `docker compose build`
Expected: all three images build (core, vault, child-discord).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(child-discord): add Dockerfile and compose service"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run all tests**

Run: `pnpm test`
Expected: every test in every package passes (contracts has no tests; core + vault + child-discord all pass).

- [ ] **Step 2: Build everything**

Run: `pnpm build && docker compose build`
Expected: all packages compile, all images build.

- [ ] **Step 3: Self-review checklist** — confirm before opening PR:
  - [ ] No `bot_token_sentinel` value appears in any test snapshot, log, or response body
  - [ ] `Credential.use()` consumption is exercised by adapter tests (both happy-path and throw-path)
  - [ ] No `console.log` left behind in src/
  - [ ] `parseCommunityRef` accepts only the documented format and returns `null` (not throws) on malformed input
  - [ ] The integration test imports child-discord from `dist/`, so `pnpm build` is part of the test setup

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin plan-3-child-discord
gh pr create --title "Plan 3: child-discord + vault integration + core routing" --body "..."
```

PR body lists:
- Summary of what landed
- Decisions D1–D6 with reasoning
- Test plan (unit, server, integration, end-to-end chain)
- Notes on what's deferred (live Discord smoke test until staging bot exists)
