# Persona Vault Service + Staging Persona Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a sops+age-backed persona vault service that exposes per-persona-per-platform credential lookups over a Unix-domain HTTP socket, plus a `Credential` client wrapper with redaction guards and a bootstrapped `_staging_alpha` persona.

**Architecture:** The vault is a long-running TypeScript service. At startup it loads `SOPS_AGE_KEY_FILE` from env (a path to an age identity file mounted read-only from the host; key bytes are read by `sops` per call, never copied into the vault process memory or disk). The vault discovers personas by scanning `personas/<id>/identity.yaml` files. On every credential request it shells out to `sops --decrypt` against `personas/<id>/credentials.sops.yaml`, returns ONLY the requested platform's sub-bundle (no bulk-dump endpoint exists), and appends an entry to an append-only JSON-Lines audit log. The HTTP listener binds to a Unix domain socket — filesystem perms (mode 0660, group ownership) are the auth. A `Credential` wrapper class is exported from the vault package for child MCPs to wrap returned bundles; the wrapper overrides `toJSON`, `toString`, and `util.inspect.custom` to render `[Credential redacted]`, preventing accidental disclosure via `console.log` or structured loggers.

**Tech Stack:** Node.js 20, TypeScript 5, `sops` CLI (Mozilla, in alpine community repo), `age` CLI (transitively via sops), `js-yaml`, native `node:http` over `node:net` Unix socket, Vitest.

**Scope (covers §15 step 2 only):** persona vault + one staging persona + the client-side Credential wrapper. The vault is wired into docker-compose but the core MCP does not yet consume it — that integration arrives with Plan 3 (`child-discord`). Idempotency ledger, rate-limit accountant, telemetry, and child MCPs are deferred.

**Decisions surfaced (not pre-resolved by the amendments):**

1. **`sops` invocation model:** Vault shells out to the `sops` CLI binary rather than using a Node port of sops/age. Reason: sops is the canonical implementation, and shelling out keeps key handling inside an audited Go binary instead of reimplementing in JS. Trade-off: requires `sops` and `age` binaries in the vault container. We pin to alpine community repo versions and document them.
2. **Age key bytes are NOT held in vault process memory.** Vault inherits `SOPS_AGE_KEY_FILE` env from the host bind-mount; sops reads the file per-decryption. This trades a small per-call I/O cost for the property that `gcore`-ing the vault PID does not yield the master key.
3. **Vault transport: Node `http` over Unix socket** — not gRPC, not a separate MCP server. Reasons: debuggable with `curl --unix-socket`, single dependency (stdlib), small attack surface, JSON request/response. Filesystem perms enforce auth.
4. **Audit log persistence:** append-only JSON Lines file at `/var/lib/social-manifold/vault-audit.jsonl` inside the container, mounted as a named volume. Rotation deferred to Plan 6 (telemetry).
5. **Staging persona age key is generated locally per-operator** (not checked in). The bootstrap script creates a fresh key in `personas/_staging_alpha/.age.key` (mode 0400) on first run. CI integration is deferred (no CI yet).
6. **`Credential` wrapper lives in `services/persona-vault/src/client/`** and is exported from the workspace package. Child MCPs in later plans import it. A future shared-types package can reabsorb it.

---

### Task 1: Workspace expansion + vault package skeleton

**Files:**
- Modify: `pnpm-workspace.yaml` (add `services/*`)
- Create: `services/persona-vault/package.json`
- Create: `services/persona-vault/tsconfig.json`
- Create: `services/persona-vault/vitest.config.ts`
- Create: `services/persona-vault/src/types.ts`

- [ ] **Step 1: Update `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
  - "services/*"
```

- [ ] **Step 2: Create `services/persona-vault/package.json`**

```json
{
  "name": "@social-manifold/persona-vault",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/server.js",
  "exports": {
    ".": "./dist/server.js",
    "./client": "./dist/client/credential.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.11.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 3: Create `services/persona-vault/tsconfig.json`**

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

- [ ] **Step 4: Create `services/persona-vault/vitest.config.ts`**

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

- [ ] **Step 5: Create `services/persona-vault/src/types.ts`**

```typescript
export interface Identity {
  id: string;
  display_name: string;
  type: "principal" | "branded_bot" | "service_account";
  timezone: string;
  locale: string;
  working_hours: string;
  posting_cadence_minutes: [number, number];
  proxy_pool: string;
  disclosed_automation: boolean;
  platforms: Record<string, { enabled: boolean; credential_ref?: string }>;
}

export interface CredentialBundle {
  [platform: string]: Record<string, string>;
}

export interface CredentialRequest {
  requester_id: string;
  purpose: string;
}

export interface CredentialResponse {
  persona_id: string;
  platform: string;
  credential: Record<string, string>;
}

export interface AuditEntry {
  ts: string;
  persona_id: string;
  platform: string;
  requester_id: string;
  purpose: string;
}

export interface ListPersonasResponse {
  personas: string[];
}

export interface ListPlatformsResponse {
  persona_id: string;
  platforms: string[];
}
```

- [ ] **Step 6: Install dependencies**

Run: `cd /home/rucaradio/tori/social-manifold && pnpm install`
Expected: lockfile updated, `@social-manifold/persona-vault` added to workspace.

- [ ] **Step 7: Commit**

```bash
cd /home/rucaradio/tori/social-manifold
git add -A
git commit -m "feat(vault): add persona-vault package skeleton and types"
```

---

### Task 2: Credential wrapper with redaction guards (TDD)

**Files:**
- Create: `services/persona-vault/tests/credential.test.ts`
- Create: `services/persona-vault/src/client/credential.ts`

- [ ] **Step 1: Write the failing test**

Path: `services/persona-vault/tests/credential.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { Credential } from "../src/client/credential.js";

describe("Credential wrapper", () => {
  it("returns the underlying value via .get()", () => {
    const cred = new Credential({ token: "secret-token", api_key: "sk-123" });
    expect(cred.get("token")).toBe("secret-token");
    expect(cred.get("api_key")).toBe("sk-123");
    expect(cred.get("missing")).toBeUndefined();
  });

  it("redacts via toString()", () => {
    const cred = new Credential({ token: "secret-token" });
    expect(String(cred)).toBe("[Credential redacted]");
    expect(`creds: ${cred}`).toBe("creds: [Credential redacted]");
  });

  it("redacts via JSON.stringify()", () => {
    const cred = new Credential({ token: "secret-token" });
    expect(JSON.stringify(cred)).toBe('"[Credential redacted]"');
    expect(JSON.stringify({ wrapped: cred })).toBe(
      '{"wrapped":"[Credential redacted]"}',
    );
  });

  it("redacts via util.inspect (used by console.log)", () => {
    const cred = new Credential({ token: "secret-token" });
    expect(inspect(cred)).toBe("[Credential redacted]");
    expect(inspect({ wrapped: cred })).toBe(
      "{ wrapped: [Credential redacted] }",
    );
  });

  it("does not expose internals as own enumerable properties", () => {
    const cred = new Credential({ token: "secret-token" });
    expect(Object.keys(cred)).toEqual([]);
    expect(Object.values(cred)).toEqual([]);
  });

  it("scopes raw access via .use(callback)", async () => {
    const cred = new Credential({ token: "secret-token" });
    const result = await cred.use(async (raw) => {
      return raw.token.toUpperCase();
    });
    expect(result).toBe("SECRET-TOKEN");
  });

  it("does not leak the secret string through the default error trace", () => {
    const cred = new Credential({ token: "secret-token" });
    try {
      // simulate a logger that stringifies the whole context
      const ctx = { user: "alice", cred };
      throw new Error(`failure: ${JSON.stringify(ctx)}`);
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-token");
      expect((err as Error).message).toContain("[Credential redacted]");
    }
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm --filter @social-manifold/persona-vault test`
Expected: FAIL — `Cannot find module '../src/client/credential.js'`.

- [ ] **Step 3: Implement `services/persona-vault/src/client/credential.ts`**

```typescript
const REDACTED = "[Credential redacted]";
const inspectSym = Symbol.for("nodejs.util.inspect.custom");

export class Credential {
  readonly #raw: Record<string, string>;

  constructor(raw: Record<string, string>) {
    this.#raw = { ...raw };
  }

  get(key: string): string | undefined {
    return this.#raw[key];
  }

  async use<T>(fn: (raw: Record<string, string>) => Promise<T> | T): Promise<T> {
    return fn({ ...this.#raw });
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspectSym](): string {
    return REDACTED;
  }
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm --filter @social-manifold/persona-vault test`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/rucaradio/tori/social-manifold
git add -A
git commit -m "feat(vault): add Credential wrapper with redaction guards"
```

---

### Task 3: Disk layer + audit log (TDD)

**Files:**
- Create: `services/persona-vault/tests/disk.test.ts`
- Create: `services/persona-vault/tests/audit.test.ts`
- Create: `services/persona-vault/tests/helpers.ts`
- Create: `services/persona-vault/src/disk.ts`
- Create: `services/persona-vault/src/audit.ts`

- [ ] **Step 1: Create test helper for tmp persona roots**

Path: `services/persona-vault/tests/helpers.ts`
```typescript
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeTmpPersonaRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vault-test-"));
}

export async function writePersona(
  root: string,
  id: string,
  identityYaml: string,
  encryptedYaml?: string,
): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "identity.yaml"), identityYaml, "utf8");
  if (encryptedYaml !== undefined) {
    await writeFile(join(dir, "credentials.sops.yaml"), encryptedYaml, "utf8");
  }
  return dir;
}

export const SAMPLE_IDENTITY = `id: persona_test
display_name: "Test Persona"
type: branded_bot
timezone: UTC
locale: en-US
working_hours: "00:00-23:59"
posting_cadence_minutes: [1, 3]
proxy_pool: none_test_only
disclosed_automation: true
platforms:
  discord:
    enabled: true
    credential_ref: discord_token
  reddit:
    enabled: false
`;
```

- [ ] **Step 2: Write the failing test for disk.ts**

Path: `services/persona-vault/tests/disk.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { listPersonas, loadIdentity } from "../src/disk.js";
import { makeTmpPersonaRoot, writePersona, SAMPLE_IDENTITY } from "./helpers.js";

describe("disk layer", () => {
  it("lists persona IDs from a root directory", async () => {
    const root = await makeTmpPersonaRoot();
    await writePersona(root, "persona_a", SAMPLE_IDENTITY);
    await writePersona(root, "persona_b", SAMPLE_IDENTITY);

    const ids = await listPersonas(root);
    expect(ids.sort()).toEqual(["persona_a", "persona_b"]);
  });

  it("ignores directories without identity.yaml", async () => {
    const root = await makeTmpPersonaRoot();
    await writePersona(root, "persona_a", SAMPLE_IDENTITY);
    // junk dir with no identity.yaml
    const { mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(join(root, "not_a_persona"), { recursive: true });

    const ids = await listPersonas(root);
    expect(ids).toEqual(["persona_a"]);
  });

  it("loads and parses identity.yaml", async () => {
    const root = await makeTmpPersonaRoot();
    await writePersona(root, "persona_a", SAMPLE_IDENTITY);

    const id = await loadIdentity(root, "persona_a");
    expect(id.id).toBe("persona_test");
    expect(id.display_name).toBe("Test Persona");
    expect(id.platforms.discord.enabled).toBe(true);
    expect(id.platforms.reddit.enabled).toBe(false);
  });

  it("throws when identity.yaml is missing", async () => {
    const root = await makeTmpPersonaRoot();
    await expect(loadIdentity(root, "no_such_persona")).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/persona-vault test`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `services/persona-vault/src/disk.ts`**

```typescript
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import type { Identity } from "./types.js";

export async function listPersonas(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      await stat(join(root, e.name, "identity.yaml"));
      ids.push(e.name);
    } catch {
      // missing identity.yaml — not a persona
    }
  }
  return ids;
}

export async function loadIdentity(
  root: string,
  personaId: string,
): Promise<Identity> {
  const path = join(root, personaId, "identity.yaml");
  const raw = await readFile(path, "utf8");
  const parsed = yaml.load(raw) as Identity;
  if (!parsed || typeof parsed !== "object" || !parsed.id) {
    throw new Error(`invalid identity.yaml at ${path}`);
  }
  return parsed;
}

export function credentialsPath(root: string, personaId: string): string {
  return join(root, personaId, "credentials.sops.yaml");
}
```

- [ ] **Step 5: Write failing test for audit.ts**

Path: `services/persona-vault/tests/audit.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, readAudit } from "../src/audit.js";

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "audit-test-"));
  return join(dir, "audit.jsonl");
}

describe("audit log", () => {
  it("appends entries as JSON Lines", async () => {
    const path = await tmpFile();
    await appendAudit(path, {
      ts: "2026-04-25T12:00:00Z",
      persona_id: "p1",
      platform: "discord",
      requester_id: "child-discord",
      purpose: "post_to_community",
    });
    await appendAudit(path, {
      ts: "2026-04-25T12:00:01Z",
      persona_id: "p1",
      platform: "reddit",
      requester_id: "child-reddit",
      purpose: "reply_to_thread",
    });

    const raw = await readFile(path, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).platform).toBe("discord");
    expect(JSON.parse(lines[1]).platform).toBe("reddit");
  });

  it("reads back parsed entries", async () => {
    const path = await tmpFile();
    await appendAudit(path, {
      ts: "2026-04-25T12:00:00Z",
      persona_id: "p1",
      platform: "discord",
      requester_id: "x",
      purpose: "y",
    });
    const entries = await readAudit(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].requester_id).toBe("x");
  });

  it("returns empty array when audit file does not exist", async () => {
    const path = await tmpFile();
    const entries = await readAudit(path);
    expect(entries).toEqual([]);
  });
});
```

- [ ] **Step 6: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/persona-vault test`
Expected: audit tests fail.

- [ ] **Step 7: Implement `services/persona-vault/src/audit.ts`**

```typescript
import { appendFile, readFile } from "node:fs/promises";
import type { AuditEntry } from "./types.js";

export async function appendAudit(
  path: string,
  entry: AuditEntry,
): Promise<void> {
  await appendFile(path, JSON.stringify(entry) + "\n", { encoding: "utf8" });
}

export async function readAudit(path: string): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}
```

- [ ] **Step 8: Run, expect PASS**

Run: `pnpm --filter @social-manifold/persona-vault test`
Expected: all tests pass (disk + audit + credential = ~14 tests).

- [ ] **Step 9: Commit**

```bash
cd /home/rucaradio/tori/social-manifold
git add -A
git commit -m "feat(vault): add disk and audit-log layers"
```

---

### Task 4: sops decryption (TDD with positive + negative)

**Files:**
- Create: `services/persona-vault/tests/sops.test.ts`
- Create: `services/persona-vault/src/sops.ts`

This task requires `sops` and `age` binaries on PATH. If not present, the test suite should skip with a clear message.

- [ ] **Step 1: Confirm sops + age availability**

Run: `which sops age 2>&1; sops --version 2>&1; age --version 2>&1`
Expected: paths and versions printed. If missing, install:
- macOS: `brew install sops age`
- Debian/Ubuntu: `apt install age` and download sops from GitHub releases
- Alpine (used in container): `apk add sops age`

If unavailable on dev host, install before continuing — the integration tests in this task cannot be replaced with mocks without losing the property they prove.

- [ ] **Step 2: Write the failing test**

Path: `services/persona-vault/tests/sops.test.ts`
```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptSopsYaml } from "../src/sops.js";

const exec = promisify(execFile);

interface TestVault {
  ageKeyPath: string;
  ageRecipient: string;
}

async function generateAgeIdentity(): Promise<TestVault> {
  const dir = await mkdtemp(join(tmpdir(), "vault-age-"));
  const keyPath = join(dir, "test.age.key");
  const { stdout } = await exec("age-keygen", ["-o", keyPath]);
  await chmod(keyPath, 0o400);
  // age-keygen prints "Public key: age1..." to stderr/stdout depending on version.
  // Read the key file directly to extract the recipient.
  const contents = await readFile(keyPath, "utf8");
  const recipientMatch = contents.match(/# public key: (age1[a-z0-9]+)/i);
  if (!recipientMatch) {
    // older age-keygen prints recipient via stdout
    const altMatch = stdout.match(/Public key: (age1[a-z0-9]+)/);
    if (!altMatch) throw new Error("could not extract age recipient");
    return { ageKeyPath: keyPath, ageRecipient: altMatch[1] };
  }
  return { ageKeyPath: keyPath, ageRecipient: recipientMatch[1] };
}

async function encryptWithSops(
  plaintextYaml: string,
  recipient: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vault-enc-"));
  const inPath = join(dir, "plain.yaml");
  await writeFile(inPath, plaintextYaml, "utf8");
  await exec("sops", [
    "--encrypt",
    "--age",
    recipient,
    "--in-place",
    inPath,
  ]);
  return inPath;
}

describe("sops decryption", () => {
  let vault: TestVault;

  beforeAll(async () => {
    vault = await generateAgeIdentity();
  });

  it("decrypts a sops-encrypted yaml file given the age key", async () => {
    const plaintext = `discord:
  bot_token: discord-bot-token-xyz
  application_id: "111111111"
reddit:
  client_id: reddit-client-id
  client_secret: reddit-client-secret
`;
    const encryptedPath = await encryptWithSops(plaintext, vault.ageRecipient);

    const decrypted = await decryptSopsYaml(encryptedPath, vault.ageKeyPath);
    expect(decrypted.discord).toBeDefined();
    expect((decrypted.discord as Record<string, string>).bot_token).toBe(
      "discord-bot-token-xyz",
    );
    expect((decrypted.reddit as Record<string, string>).client_secret).toBe(
      "reddit-client-secret",
    );
  });

  it("NEGATIVE: encrypted file on disk contains ciphertext, not plaintext", async () => {
    const plaintext = `discord:
  bot_token: NEVER-LEAK-THIS-VALUE
`;
    const encryptedPath = await encryptWithSops(plaintext, vault.ageRecipient);

    const onDisk = await readFile(encryptedPath, "utf8");
    expect(onDisk).not.toContain("NEVER-LEAK-THIS-VALUE");
    expect(onDisk).toContain("sops:"); // sops metadata block is present
    expect(onDisk).toMatch(/ENC\[/); // sops AES envelope marker
  });

  it("NEGATIVE: decryption fails without the age key", async () => {
    const plaintext = `discord:
  bot_token: another-secret
`;
    const encryptedPath = await encryptWithSops(plaintext, vault.ageRecipient);

    await expect(
      decryptSopsYaml(encryptedPath, "/nonexistent/key/path"),
    ).rejects.toThrow();
  });

  it("NEGATIVE: decryption fails with the wrong age key", async () => {
    const plaintext = `discord:
  bot_token: yet-another-secret
`;
    const encryptedPath = await encryptWithSops(plaintext, vault.ageRecipient);

    const otherVault = await generateAgeIdentity();
    await expect(
      decryptSopsYaml(encryptedPath, otherVault.ageKeyPath),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/persona-vault test`
Expected: sops tests fail (module missing).

- [ ] **Step 4: Implement `services/persona-vault/src/sops.ts`**

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function decryptSopsYaml(
  filePath: string,
  ageKeyPath: string,
): Promise<Record<string, unknown>> {
  const { stdout } = await exec(
    "sops",
    ["--decrypt", "--input-type", "yaml", "--output-type", "json", filePath],
    {
      env: {
        ...process.env,
        SOPS_AGE_KEY_FILE: ageKeyPath,
      },
    },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}
```

- [ ] **Step 5: Run, expect PASS**

Run: `pnpm --filter @social-manifold/persona-vault test`
Expected: all 4 sops tests pass; total ~18 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/rucaradio/tori/social-manifold
git add -A
git commit -m "feat(vault): add sops decryption with positive and negative tests"
```

---

### Task 5: Vault HTTP-over-UDS server (TDD)

**Files:**
- Create: `services/persona-vault/tests/server.test.ts`
- Create: `services/persona-vault/src/server.ts`

The server is the integration point. The test exercises the full path: HTTP request over a Unix socket → route → disk → sops decryption → audit append → response. Plus the bulk-dump-prevention check (no endpoint returns more than one platform's creds at a time).

- [ ] **Step 1: Write the failing integration test**

Path: `services/persona-vault/tests/server.test.ts`
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { Server } from "node:http";
import { createVaultServer } from "../src/server.js";
import { Credential } from "../src/client/credential.js";

const exec = promisify(execFile);

async function generateAgeIdentity(): Promise<{
  keyPath: string;
  recipient: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "vault-age-"));
  const keyPath = join(dir, "test.age.key");
  const { stdout } = await exec("age-keygen", ["-o", keyPath]);
  await chmod(keyPath, 0o400);
  const contents = await readFile(keyPath, "utf8");
  const m =
    contents.match(/# public key: (age1[a-z0-9]+)/i) ??
    stdout.match(/Public key: (age1[a-z0-9]+)/);
  if (!m) throw new Error("no recipient");
  return { keyPath, recipient: m[1] };
}

interface TestRig {
  socket: string;
  personasRoot: string;
  auditPath: string;
  ageKey: string;
  server: Server;
}

async function setupRig(): Promise<TestRig> {
  const tmp = await mkdtemp(join(tmpdir(), "vault-srv-"));
  const personasRoot = join(tmp, "personas");
  await mkdir(personasRoot, { recursive: true });

  const personaDir = join(personasRoot, "persona_test");
  await mkdir(personaDir, { recursive: true });
  await writeFile(
    join(personaDir, "identity.yaml"),
    `id: persona_test
display_name: "Test"
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
  reddit:
    enabled: true
    credential_ref: reddit_oauth
`,
    "utf8",
  );

  const { keyPath, recipient } = await generateAgeIdentity();
  const credYaml = `discord:
  bot_token: discord-bot-token-xyz
  application_id: "111"
reddit:
  client_id: reddit-id
  client_secret: reddit-secret
`;
  const credPath = join(personaDir, "credentials.sops.yaml");
  await writeFile(credPath, credYaml, "utf8");
  await exec("sops", ["--encrypt", "--age", recipient, "--in-place", credPath]);

  const auditPath = join(tmp, "audit.jsonl");
  const socket = join(tmp, "vault.sock");
  const server = await createVaultServer({
    personasRoot,
    auditPath,
    ageKeyPath: keyPath,
    socketPath: socket,
  });

  return { socket, personasRoot, auditPath, ageKey: keyPath, server };
}

function uds(
  socketPath: string,
  method: string,
  path: string,
  body?: object,
): Promise<{ status: number; body: any }> {
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

describe("vault HTTP-over-UDS server", () => {
  let rig: TestRig;

  beforeAll(async () => {
    rig = await setupRig();
  });

  afterAll(async () => {
    await new Promise<void>((r) => rig.server.close(() => r()));
  });

  it("GET /v1/personas lists persona IDs", async () => {
    const res = await uds(rig.socket, "GET", "/v1/personas");
    expect(res.status).toBe(200);
    expect(res.body.personas).toEqual(["persona_test"]);
  });

  it("GET /v1/personas/:id/platforms lists enabled platforms", async () => {
    const res = await uds(
      rig.socket,
      "GET",
      "/v1/personas/persona_test/platforms",
    );
    expect(res.status).toBe(200);
    expect(res.body.persona_id).toBe("persona_test");
    expect(res.body.platforms.sort()).toEqual(["discord", "reddit"]);
  });

  it("POST credentials returns ONLY the requested platform's creds", async () => {
    const res = await uds(
      rig.socket,
      "POST",
      "/v1/personas/persona_test/credentials/discord",
      { requester_id: "test-runner", purpose: "vault server test" },
    );
    expect(res.status).toBe(200);
    expect(res.body.persona_id).toBe("persona_test");
    expect(res.body.platform).toBe("discord");
    expect(res.body.credential.bot_token).toBe("discord-bot-token-xyz");
    expect(res.body.credential.application_id).toBe("111");
    // crucial: reddit creds MUST NOT appear in this response
    expect(JSON.stringify(res.body)).not.toContain("reddit-secret");
    expect(JSON.stringify(res.body)).not.toContain("reddit-id");
  });

  it("appends an audit entry on successful credential read", async () => {
    await uds(
      rig.socket,
      "POST",
      "/v1/personas/persona_test/credentials/reddit",
      { requester_id: "audit-test", purpose: "smoke" },
    );
    const audit = await readFile(rig.auditPath, "utf8");
    expect(audit).toContain('"requester_id":"audit-test"');
    expect(audit).toContain('"platform":"reddit"');
    // audit log must NOT contain the actual secret
    expect(audit).not.toContain("reddit-secret");
  });

  it("returns 404 for an unknown persona", async () => {
    const res = await uds(
      rig.socket,
      "POST",
      "/v1/personas/nope/credentials/discord",
      { requester_id: "x", purpose: "y" },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown platform on a known persona", async () => {
    const res = await uds(
      rig.socket,
      "POST",
      "/v1/personas/persona_test/credentials/twitter",
      { requester_id: "x", purpose: "y" },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when requester_id or purpose is missing", async () => {
    const res = await uds(
      rig.socket,
      "POST",
      "/v1/personas/persona_test/credentials/discord",
      { requester_id: "" },
    );
    expect(res.status).toBe(400);
  });

  it("has NO bulk-dump endpoint — listing personas does not return credentials", async () => {
    const res = await uds(rig.socket, "GET", "/v1/personas");
    expect(JSON.stringify(res.body)).not.toContain("bot_token");
    expect(JSON.stringify(res.body)).not.toContain("client_secret");
  });

  it("client wraps the response credential into a redacting Credential", async () => {
    const res = await uds(
      rig.socket,
      "POST",
      "/v1/personas/persona_test/credentials/discord",
      { requester_id: "wrap-test", purpose: "demo" },
    );
    const cred = new Credential(res.body.credential);
    expect(cred.get("bot_token")).toBe("discord-bot-token-xyz");
    expect(JSON.stringify(cred)).toBe('"[Credential redacted]"');
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @social-manifold/persona-vault test`
Expected: server tests fail — module not found.

- [ ] **Step 3: Implement `services/persona-vault/src/server.ts`**

```typescript
import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { unlink, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listPersonas, loadIdentity, credentialsPath } from "./disk.js";
import { decryptSopsYaml } from "./sops.js";
import { appendAudit } from "./audit.js";
import type {
  CredentialRequest,
  CredentialResponse,
  ListPersonasResponse,
  ListPlatformsResponse,
  AuditEntry,
} from "./types.js";

export interface VaultConfig {
  personasRoot: string;
  auditPath: string;
  ageKeyPath: string;
  socketPath: string;
}

interface RouteCtx {
  config: VaultConfig;
  req: IncomingMessage;
  res: ServerResponse;
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

async function handleListPersonas(ctx: RouteCtx): Promise<void> {
  const ids = await listPersonas(ctx.config.personasRoot);
  const body: ListPersonasResponse = { personas: ids };
  send(ctx.res, 200, body);
}

async function handleListPlatforms(
  ctx: RouteCtx,
  personaId: string,
): Promise<void> {
  try {
    const id = await loadIdentity(ctx.config.personasRoot, personaId);
    const platforms = Object.entries(id.platforms)
      .filter(([, v]) => v.enabled)
      .map(([k]) => k);
    const body: ListPlatformsResponse = { persona_id: personaId, platforms };
    send(ctx.res, 200, body);
  } catch {
    send(ctx.res, 404, { error: "persona not found" });
  }
}

async function handleGetCredential(
  ctx: RouteCtx,
  personaId: string,
  platform: string,
): Promise<void> {
  const body = (await readJsonBody(ctx.req)) as Partial<CredentialRequest> | null;
  if (
    !body ||
    typeof body.requester_id !== "string" ||
    typeof body.purpose !== "string" ||
    body.requester_id.length === 0 ||
    body.purpose.length === 0
  ) {
    send(ctx.res, 400, { error: "requester_id and purpose are required" });
    return;
  }

  let identity;
  try {
    identity = await loadIdentity(ctx.config.personasRoot, personaId);
  } catch {
    send(ctx.res, 404, { error: "persona not found" });
    return;
  }
  if (!identity.platforms[platform]?.enabled) {
    send(ctx.res, 404, { error: "platform not enabled for persona" });
    return;
  }

  let bundle: Record<string, unknown>;
  try {
    bundle = await decryptSopsYaml(
      credentialsPath(ctx.config.personasRoot, personaId),
      ctx.config.ageKeyPath,
    );
  } catch (err) {
    send(ctx.res, 500, { error: "decryption failed" });
    return;
  }

  const platformCreds = bundle[platform];
  if (!platformCreds || typeof platformCreds !== "object") {
    send(ctx.res, 404, { error: "platform credentials not found" });
    return;
  }

  const auditEntry: AuditEntry = {
    ts: new Date().toISOString(),
    persona_id: personaId,
    platform,
    requester_id: body.requester_id,
    purpose: body.purpose,
  };
  await appendAudit(ctx.config.auditPath, auditEntry);

  const responseBody: CredentialResponse = {
    persona_id: personaId,
    platform,
    credential: platformCreds as Record<string, string>,
  };
  send(ctx.res, 200, responseBody);
}

function route(config: VaultConfig) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = req.url ?? "";
      const method = req.method ?? "GET";

      if (method === "GET" && url === "/v1/personas") {
        return handleListPersonas({ config, req, res });
      }

      const platformsMatch = url.match(/^\/v1\/personas\/([^/]+)\/platforms$/);
      if (method === "GET" && platformsMatch) {
        return handleListPlatforms({ config, req, res }, platformsMatch[1]);
      }

      const credMatch = url.match(
        /^\/v1\/personas\/([^/]+)\/credentials\/([^/]+)$/,
      );
      if (method === "POST" && credMatch) {
        return handleGetCredential({ config, req, res }, credMatch[1], credMatch[2]);
      }

      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 500, { error: "internal" });
    }
  };
}

export async function createVaultServer(config: VaultConfig): Promise<Server> {
  await mkdir(dirname(config.socketPath), { recursive: true });
  try {
    await unlink(config.socketPath);
  } catch {
    /* socket didn't exist */
  }
  const server = createHttpServer(route(config));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await chmod(config.socketPath, 0o660);
  return server;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const config: VaultConfig = {
    personasRoot: process.env.VAULT_PERSONAS_ROOT ?? "/var/social-manifold/personas",
    auditPath: process.env.VAULT_AUDIT_PATH ?? "/var/lib/social-manifold/vault-audit.jsonl",
    ageKeyPath: process.env.SOPS_AGE_KEY_FILE ?? "/etc/social-manifold/age.key",
    socketPath: process.env.VAULT_SOCKET_PATH ?? "/run/social-manifold/vault.sock",
  };
  await createVaultServer(config);
  // server runs until process is killed
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @social-manifold/persona-vault test`
Expected: all server tests pass; total suite ~26 tests.

- [ ] **Step 5: Build**

Run: `pnpm --filter @social-manifold/persona-vault build`
Expected: `services/persona-vault/dist/server.js` produced.

- [ ] **Step 6: Commit**

```bash
cd /home/rucaradio/tori/social-manifold
git add -A
git commit -m "feat(vault): add HTTP-over-UDS server with per-platform credential lookups"
```

---

### Task 6: Staging persona + bootstrap script

**Files:**
- Create: `personas/_staging_alpha/identity.yaml`
- Create: `scripts/bootstrap-staging-persona.ts`
- Modify: `.gitignore` (selective allow for `_staging_alpha/identity.yaml`)
- Modify: root `package.json` (add `persona:bootstrap-staging` script)
- Create: `scripts/package.json`
- Create: `scripts/tsconfig.json`

- [ ] **Step 1: Update root `.gitignore`**

Find and replace:
```
/personas/
!/personas/_example/
```
with:
```
/personas/*
!/personas/_example/
!/personas/_staging_alpha/
/personas/*/credentials.sops.yaml
/personas/*/.age.key
/personas/*/browser-profile/
```

- [ ] **Step 2: Create `personas/_staging_alpha/identity.yaml`** (committed; plaintext, no secrets)

```yaml
id: _staging_alpha
display_name: "Staging Alpha (test persona, no production access)"
type: branded_bot
timezone: UTC
locale: en-US
working_hours: "00:00-23:59"
posting_cadence_minutes: [1, 3]
proxy_pool: none_test_only
disclosed_automation: true
platforms:
  discord:
    enabled: true
    credential_ref: discord_token
  reddit:
    enabled: false
```

- [ ] **Step 3: Create `scripts/package.json`**

```json
{
  "name": "@social-manifold/scripts",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "bootstrap-staging-persona": "tsx bootstrap-staging-persona.ts"
  },
  "dependencies": {
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.11.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 4: Create `scripts/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 5: Create `scripts/bootstrap-staging-persona.ts`**

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  chmod,
  readFile,
  writeFile,
  rename,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";

const exec = promisify(execFile);

const PERSONA_ID = "_staging_alpha";
const REPO_ROOT = process.cwd();
const PERSONA_DIR = join(REPO_ROOT, "personas", PERSONA_ID);
const KEY_PATH = join(PERSONA_DIR, ".age.key");
const CRED_PATH = join(PERSONA_DIR, "credentials.sops.yaml");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function generateAgeKey(): Promise<string> {
  const tmpKey = `${KEY_PATH}.tmp`;
  const { stdout } = await exec("age-keygen", ["-o", tmpKey]);
  await chmod(tmpKey, 0o400);
  await rename(tmpKey, KEY_PATH);
  const contents = await readFile(KEY_PATH, "utf8");
  const m =
    contents.match(/# public key: (age1[a-z0-9]+)/i) ??
    stdout.match(/Public key: (age1[a-z0-9]+)/);
  if (!m) throw new Error("could not extract age recipient from generated key");
  return m[1];
}

async function readRecipient(): Promise<string> {
  const contents = await readFile(KEY_PATH, "utf8");
  const m = contents.match(/# public key: (age1[a-z0-9]+)/i);
  if (!m) throw new Error("existing key file missing recipient comment");
  return m[1];
}

async function encryptStagingCreds(recipient: string): Promise<void> {
  const fakeYaml = `discord:
  bot_token: STAGING-FAKE-DISCORD-BOT-TOKEN-DO-NOT-USE
  application_id: "000000000000000000"
`;
  await writeFile(CRED_PATH, fakeYaml, "utf8");
  await exec("sops", ["--encrypt", "--age", recipient, "--in-place", CRED_PATH]);
}

async function main(): Promise<void> {
  await mkdir(PERSONA_DIR, { recursive: true });

  let recipient: string;
  if (await exists(KEY_PATH)) {
    console.log(`age key already exists at ${KEY_PATH}, reusing`);
    recipient = await readRecipient();
  } else {
    console.log(`generating age key at ${KEY_PATH}`);
    recipient = await generateAgeKey();
  }
  console.log(`recipient: ${recipient}`);

  if (await exists(CRED_PATH)) {
    console.log(`credentials already exist at ${CRED_PATH}, leaving untouched`);
    return;
  }
  console.log(`encrypting staging credentials → ${CRED_PATH}`);
  await encryptStagingCreds(recipient);
  console.log("done. Set SOPS_AGE_KEY_FILE=" + KEY_PATH + " to use this vault.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 6: Add the script to root `package.json`**

Find:
```json
"scripts": {
  "build": "pnpm -r build",
  "test": "pnpm -r test"
}
```
Replace with:
```json
"scripts": {
  "build": "pnpm -r build",
  "test": "pnpm -r test",
  "persona:bootstrap-staging": "pnpm --filter @social-manifold/scripts bootstrap-staging-persona"
}
```

- [ ] **Step 7: Install (picks up the new scripts package)**

Run: `cd /home/rucaradio/tori/social-manifold && pnpm install`
Expected: `@social-manifold/scripts` added to workspace.

- [ ] **Step 8: Run the bootstrap script and verify**

Run: `pnpm persona:bootstrap-staging`
Expected: creates `personas/_staging_alpha/.age.key` (mode 0400) and `personas/_staging_alpha/credentials.sops.yaml`. Re-running is idempotent.

Verify:
```bash
ls -la personas/_staging_alpha/
cat personas/_staging_alpha/credentials.sops.yaml | head -3
```
The credentials file should be a sops-encrypted YAML (contains `sops:` block, no plaintext token).

- [ ] **Step 9: Verify the staging persona doesn't bring secrets into git**

Run: `git status --ignored personas/_staging_alpha/`
Expected: `identity.yaml` is the only tracked file; `credentials.sops.yaml` and `.age.key` show as ignored.

- [ ] **Step 10: Commit**

```bash
cd /home/rucaradio/tori/social-manifold
git add -A
git commit -m "feat(vault): add staging persona and bootstrap script"
```

---

### Task 7: Compose + .env + Dockerfile wiring

**Files:**
- Create: `services/persona-vault/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 1: Create `services/persona-vault/Dockerfile`**

```dockerfile
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
# SOPS_AGE_KEY_FILE is set by the operator at runtime; default location
# is /etc/social-manifold/age.key (mounted from the host as 0400, ro)
ENV SOPS_AGE_KEY_FILE=/etc/social-manifold/age.key
CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Update `docker-compose.yml` to add the vault service**

Replace the file contents with:
```yaml
services:
  core:
    build:
      context: .
      dockerfile: packages/core/Dockerfile
    image: social-manifold/core:dev
    stdin_open: true
    tty: false
    restart: "no"
    networks:
      - manifold_core

  vault:
    build:
      context: .
      dockerfile: services/persona-vault/Dockerfile
    image: social-manifold/persona-vault:dev
    restart: unless-stopped
    networks:
      - manifold_core
    volumes:
      # personas directory mounted read-only — vault never writes back
      - ./personas:/var/social-manifold/personas:ro
      # age key mounted from host path defined in .env
      - ${AGE_KEY_PATH:-./personas/_staging_alpha/.age.key}:/etc/social-manifold/age.key:ro
      # vault Unix socket exposed on the host so children (and core) can connect
      - ./run/social-manifold:/run/social-manifold
      # audit log persists across restarts
      - vault_audit:/var/lib/social-manifold

networks:
  manifold_core:
    driver: bridge

volumes:
  vault_audit:
```

- [ ] **Step 3: Update `.env.example`**

Replace contents with:
```
# Persona vault (sops + age) — see CLAUDE.md §6
# Path on the host to the age identity file. Default points at the staging
# persona's local key, generated by `pnpm persona:bootstrap-staging`. For
# production, point this at /etc/social-manifold/age.key (mode 0400).
AGE_KEY_PATH=./personas/_staging_alpha/.age.key

# Proxy manager — see CLAUDE.md §8
PROXY_MANAGER_TOKEN=
```

- [ ] **Step 4: Build the vault image**

Run: `cd /home/rucaradio/tori/social-manifold && docker compose build vault`
Expected: image built successfully.

- [ ] **Step 5: Verify the vault image runs and serves the socket**

Note: the bootstrapped staging key + credentials must exist locally first (Task 6 step 8). The compose file mounts `./run/social-manifold` from the host so `vault.sock` becomes addressable from outside the container.

```bash
mkdir -p ./run/social-manifold
docker compose up -d vault
sleep 1
ls -la ./run/social-manifold/vault.sock
curl --unix-socket ./run/social-manifold/vault.sock http://localhost/v1/personas
```
Expected: socket file exists; curl returns `{"personas":["_staging_alpha"]}`.

- [ ] **Step 6: Tear down**

```bash
docker compose down
rm -rf ./run
```

- [ ] **Step 7: Commit**

```bash
cd /home/rucaradio/tori/social-manifold
git add -A
git commit -m "feat(vault): wire vault service into docker-compose with UDS mount"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `cd /home/rucaradio/tori/social-manifold && pnpm test`
Expected: all tests across core + vault pass.

- [ ] **Step 2: Build all packages**

Run: `cd /home/rucaradio/tori/social-manifold && pnpm build`
Expected: every package compiles cleanly.

- [ ] **Step 3: Build all images**

Run: `cd /home/rucaradio/tori/social-manifold && docker compose build`
Expected: both `social-manifold/core:dev` and `social-manifold/persona-vault:dev` images present.

- [ ] **Step 4: Confirm clean working tree**

Run: `git status`
Expected: `nothing to commit, working tree clean`.

- [ ] **Step 5: Push branch and open PR**

```bash
git push -u origin plan-2-persona-vault
gh pr create --title "Plan 2: persona vault + staging persona" --body "$(cat <<'EOF'
## Summary
- Adds `@social-manifold/persona-vault` service: HTTP-over-UDS server, sops+age decryption, per-platform credential lookups (no bulk-dump endpoint), append-only JSON-Lines audit log.
- Adds `Credential` client wrapper with redaction guards (`toJSON`/`toString`/`util.inspect.custom` all return `[Credential redacted]`).
- Adds `_staging_alpha` persona and `pnpm persona:bootstrap-staging` script that generates a local age key and encrypts fake staging credentials.
- Wires the vault into `docker-compose.yml` with a host bind-mount for the UDS and a read-only mount for the age key.
- Updates `.gitignore` so `_staging_alpha/identity.yaml` is tracked but `.age.key` and `credentials.sops.yaml` are ignored.

## Test Plan
- [ ] `pnpm test` — all unit + integration tests pass, including:
  - Credential redaction guards (`toJSON`, `toString`, `util.inspect`)
  - sops decryption positive path
  - sops NEGATIVE: encrypted file on disk contains ciphertext, not plaintext
  - sops NEGATIVE: decryption fails without the age key
  - Vault server: per-platform fetch returns ONLY that platform's creds (other platforms' values absent from response)
  - Audit log records reads but never logs the secret values
- [ ] `pnpm persona:bootstrap-staging` is idempotent
- [ ] `docker compose build` produces both images
- [ ] `docker compose up -d vault` + `curl --unix-socket` returns the staging persona
EOF
)"
```
