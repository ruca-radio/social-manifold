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
  submitCalls: Array<{
    accessToken: string;
    subreddit: string;
    title: string;
    text: string;
  }>;
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
  restOverride?: RedditRestPort,
): Promise<Record<string, unknown>> {
  const mcp = createChildRedditMcpServer({
    vault: rig.vaultClient,
    oauth: rig.oauth,
    rest: restOverride ?? rig.rest,
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
    const result = await callTool(
      rig,
      {
        persona_id: "p_alpha",
        community_ref: "reddit://r/selfhosted",
        content: "x",
        idempotency_key: "ik-rl",
      },
      failingRest,
    );
    expect(result.status).toBe("failed");
    expect(
      (result.platform_rate_limit as { retry_after_seconds: number })
        ?.retry_after_seconds,
    ).toBe(180);
  });
});
