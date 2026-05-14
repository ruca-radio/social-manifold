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
import {
  createChildDiscordServer,
  type ChildDiscordServerHandle,
} from "@social-manifold/child-discord/dist/server.js";
import type { DiscordRestPort } from "@social-manifold/child-discord/dist/deps.js";
import {
  createChildRedditServer,
  type ChildRedditServerHandle,
} from "@social-manifold/child-reddit/dist/server.js";
import type { RedditRestPort } from "@social-manifold/child-reddit/dist/deps.js";
import type { RedditOAuthPort } from "@social-manifold/child-reddit/dist/auth.js";
import { createServer } from "../src/server.js";
import { DiscordChildClient } from "../src/child-clients/discord.js";
import { RedditChildClient } from "../src/child-clients/reddit.js";
import { IdempotencyLedger } from "../src/idempotency/ledger.js";
import { RateLimitAccountant } from "../src/ratelimit/accountant.js";

const exec = promisify(execFile);

interface DiscordRestCall {
  channelId: string;
  content: string;
  token: string;
}

interface RedditSubmitCall {
  accessToken: string;
  subreddit: string;
  title: string;
  text: string;
}

interface Rig {
  tmp: string;
  vault: Server;
  childDiscord: ChildDiscordServerHandle;
  childDiscordSocket: string;
  childReddit: ChildRedditServerHandle;
  childRedditSocket: string;
  discordRestCalls: DiscordRestCall[];
  redditSubmitCalls: RedditSubmitCall[];
  bot_token_sentinel: string;
  refresh_sentinel: string;
  access_sentinel: string;
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
posting_cadence_minutes: [0, 0]
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

  const ageDir = await mkdtemp(join(tmpdir(), "int-age-"));
  const ageKey = join(ageDir, "k");
  await exec("age-keygen", ["-o", ageKey]);
  await chmod(ageKey, 0o400);
  const recipient = (await readFile(ageKey, "utf8")).match(
    /# public key: (age1[a-z0-9]+)/i,
  )![1];
  const BOT_SENTINEL = "INT-BOT-SENTINEL-MCP-WX5T";
  const REFRESH_SENTINEL = "INT-REFRESH-SENTINEL-RD-PQ7";
  const ACCESS_SENTINEL = "INT-ACCESS-SENTINEL-RD-LM2";
  const credPath = join(personasRoot, "p_e2e", "credentials.sops.yaml");
  await writeFile(
    credPath,
    `discord:\n  bot_token: ${BOT_SENTINEL}\nreddit:\n  client_id: CID\n  client_secret: CSECRET\n  refresh_token: ${REFRESH_SENTINEL}\n`,
    "utf8",
  );
  await exec("sops", ["--encrypt", "--age", recipient, "--in-place", credPath]);

  const vaultSocket = join(tmp, "v.sock");
  const vault = await createVaultServer({
    personasRoot,
    auditPath: join(tmp, "audit.jsonl"),
    ageKeyPath: ageKey,
    socketPath: vaultSocket,
  });

  const discordRestCalls: DiscordRestCall[] = [];
  const fakeDiscordRest: DiscordRestPort = {
    async postMessage(channelId, content, token) {
      discordRestCalls.push({ channelId, content, token });
      return { id: "e2e-msg-id" };
    },
  };

  const childDiscordSocket = join(tmp, "child-discord.sock");
  const childDiscord = await createChildDiscordServer({
    socketPath: childDiscordSocket,
    vault: new VaultClient(vaultSocket),
    rest: fakeDiscordRest,
  });

  const redditSubmitCalls: RedditSubmitCall[] = [];
  const fakeRedditRest: RedditRestPort = {
    async submit(accessToken, input) {
      redditSubmitCalls.push({ accessToken, ...input });
      return { permalink: "/r/test/comments/y/z/" };
    },
  };
  const fakeRedditOAuth: RedditOAuthPort = {
    async exchangeRefreshToken() {
      return { access_token: ACCESS_SENTINEL, expires_in: 3600 };
    },
  };

  const childRedditSocket = join(tmp, "child-reddit.sock");
  const childReddit = await createChildRedditServer({
    socketPath: childRedditSocket,
    vault: new VaultClient(vaultSocket),
    oauth: fakeRedditOAuth,
    rest: fakeRedditRest,
  });

  return {
    tmp,
    vault,
    childDiscord,
    childDiscordSocket,
    childReddit,
    childRedditSocket,
    discordRestCalls,
    redditSubmitCalls,
    bot_token_sentinel: BOT_SENTINEL,
    refresh_sentinel: REFRESH_SENTINEL,
    access_sentinel: ACCESS_SENTINEL,
  };
}

describe("integration: HERMES → core → child-discord/reddit (MCP/UDS) → vault", () => {
  let rig: Rig;
  // Long-lived MCP clients per child (CLAUDE.md §7.5: Client lifetime is
  // process-lifetime; multiple per-child clients fail with "Server already
  // initialized").
  let sharedDiscord: DiscordChildClient;
  let sharedReddit: RedditChildClient;

  beforeAll(async () => {
    rig = await setup();
    sharedDiscord = new DiscordChildClient({ socketPath: rig.childDiscordSocket });
    sharedReddit = new RedditChildClient({ socketPath: rig.childRedditSocket });
  });
  afterAll(async () => {
    await sharedDiscord.close();
    await sharedReddit.close();
    await rig.childDiscord.close();
    await rig.childReddit.close();
    await new Promise<void>((r) => rig.vault.close(() => r()));
  });

  function makeCore(opts: { cadence?: [number, number]; ledgerName?: string }) {
    const ledger = new IdempotencyLedger(
      join(rig.tmp, opts.ledgerName ?? "idem.db"),
    );
    const accountant = new RateLimitAccountant({
      cadenceMinutes: async () => opts.cadence ?? [0, 0],
    });
    const server = createServer({
      discord: sharedDiscord,
      reddit: sharedReddit,
      ledger,
      accountant,
    });
    return { ledger, accountant, server };
  }

  async function callPost(
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    args: Record<string, unknown>,
  ) {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const mcpClient = new Client({ name: "test", version: "0.0.1" });
    await mcpClient.connect(ct);
    try {
      const callResult = await mcpClient.callTool({
        name: "post_to_community",
        arguments: args,
      });
      const text = (callResult.content as { type: string; text: string }[])[0]
        .text;
      return JSON.parse(text) as Record<string, unknown>;
    } finally {
      await mcpClient.close();
    }
  }

  it("post_to_community(discord) traverses the full MCP chain end-to-end", async () => {
    const before = rig.discordRestCalls.length;
    const { ledger, server } = makeCore({ ledgerName: "idem-e2e.db" });
    try {
      const payload = await callPost(server, {
        persona_id: "p_e2e",
        community_ref: "discord://guild:111/channel:222",
        content: "end-to-end-hello",
        idempotency_key: "ik-int",
      });

      expect(payload.status).toBe("ok");
      expect(payload.platform_response_id).toBe("e2e-msg-id");
      expect(payload.idempotency_key).toBe("ik-int");
      expect(JSON.stringify(payload)).not.toContain(rig.bot_token_sentinel);

      const newCalls = rig.discordRestCalls.slice(before);
      expect(newCalls).toHaveLength(1);
      expect(newCalls[0].token).toBe(rig.bot_token_sentinel);
      expect(newCalls[0].content).toBe("end-to-end-hello");
      expect(newCalls[0].channelId).toBe("222");
    } finally {
      ledger.close();
      await server.close();
    }
  });

  it("post_to_community(reddit) traverses the full MCP chain end-to-end", async () => {
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
      expect(payload.idempotency_key).toBe("ik-r");
      // refresh_token must NEVER appear in the MCP response
      expect(JSON.stringify(payload)).not.toContain(rig.refresh_sentinel);

      const newCalls = rig.redditSubmitCalls.slice(before);
      expect(newCalls).toHaveLength(1);
      expect(newCalls[0].accessToken).toBe(rig.access_sentinel);
      expect(newCalls[0].subreddit).toBe("selfhosted");
      expect(newCalls[0].title).toBe("Self-hosting LLMs in 2026");
      expect(newCalls[0].text).toBe("The state of the art is...");
    } finally {
      ledger.close();
      await server.close();
    }
  });

  it("a same-key retry returns deduped without re-invoking the child", async () => {
    const before = rig.discordRestCalls.length;
    const { ledger, server } = makeCore({
      ledgerName: "idem-dedup.db",
    });
    try {
      const args = {
        persona_id: "p_e2e",
        community_ref: "discord://guild:1/channel:2",
        content: "dedup-content",
        idempotency_key: "ik-dedup",
      };
      const a = await callPost(server, args);
      const b = await callPost(server, args);
      expect(a.status).toBe("ok");
      expect(b.status).toBe("deduped");
      expect(b.platform_response_id).toBe(a.platform_response_id);
      expect(rig.discordRestCalls.length - before).toBe(1);
    } finally {
      ledger.close();
      await server.close();
    }
  });

  it("rate-limits a second call without invoking the child", async () => {
    const before = rig.discordRestCalls.length;
    const { ledger, server } = makeCore({
      cadence: [10, 30],
      ledgerName: "idem-rl.db",
    });
    try {
      const a = await callPost(server, {
        persona_id: "p_e2e",
        community_ref: "discord://guild:1/channel:2",
        content: "first-rl",
        idempotency_key: "ik-rl-1",
      });
      expect(a.status).toBe("ok");
      const b = await callPost(server, {
        persona_id: "p_e2e",
        community_ref: "discord://guild:1/channel:2",
        content: "second-rl",
        idempotency_key: "ik-rl-2",
      });
      expect(b.status).toBe("failed");
      expect(
        (b.warnings as string[]).some((w) => w.includes("retry_after_seconds")),
      ).toBe(true);
      expect(rig.discordRestCalls.length - before).toBe(1);
    } finally {
      ledger.close();
      await server.close();
    }
  });
});
