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
import { createChildDiscordMcpServer } from "../src/mcp-server.js";
import type { DiscordRestPort } from "../src/deps.js";

const exec = promisify(execFile);

interface RestCall {
  channelId: string;
  content: string;
  token: string;
}

interface Rig {
  vaultServer: Server;
  vault: VaultClient;
  restCalls: RestCall[];
  bot_token_sentinel: string;
  auditPath: string;
}

async function setupRig(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), "cd-mcp-"));
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
  const ageDir = await mkdtemp(join(tmpdir(), "cd-mcp-age-"));
  const ageKey = join(ageDir, "k");
  await exec("age-keygen", ["-o", ageKey]);
  await chmod(ageKey, 0o400);
  const recipient = (await readFile(ageKey, "utf8")).match(
    /# public key: (age1[a-z0-9]+)/i,
  )![1];
  const SENTINEL = "BOT-SENTINEL-MCP-VR2P";
  const credPath = join(personasRoot, "p_alpha", "credentials.sops.yaml");
  await writeFile(credPath, `discord:\n  bot_token: ${SENTINEL}\n`, "utf8");
  await exec("sops", ["--encrypt", "--age", recipient, "--in-place", credPath]);

  const auditPath = join(tmp, "audit.jsonl");
  const socketPath = join(tmp, "v.sock");
  const vaultServer = await createVaultServer({
    personasRoot,
    auditPath,
    ageKeyPath: ageKey,
    socketPath,
  });
  const vault = new VaultClient(socketPath);

  const restCalls: RestCall[] = [];
  // shared rest reference; tests mutate the spy via closure on rig.restCalls
  return {
    vaultServer,
    vault,
    restCalls,
    bot_token_sentinel: SENTINEL,
    auditPath,
  };
}

function makeRest(rig: Rig, opts: { throwAfter?: number } = {}): DiscordRestPort {
  let i = 0;
  return {
    async postMessage(channelId, content, token) {
      i += 1;
      rig.restCalls.push({ channelId, content, token });
      if (opts.throwAfter !== undefined && i > opts.throwAfter) {
        throw new Error("simulated discord 503");
      }
      return { id: `mcp-msg-${i}` };
    },
  };
}

async function callTool(
  rig: Rig,
  rest: DiscordRestPort,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const mcp = createChildDiscordMcpServer({ vault: rig.vault, rest });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(clientTransport);

  try {
    const callResult = await client.callTool({
      name: "post_to_community",
      arguments: args,
    });
    const blocks = callResult.content as { type: string; text: string }[];
    return JSON.parse(blocks[0].text);
  } finally {
    await client.close();
    await mcp.close();
  }
}

describe("child-discord MCP tool", () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await setupRig();
  });
  afterAll(async () => {
    await new Promise<void>((r) => rig.vaultServer.close(() => r()));
  });

  it("post_to_community fetches creds from vault and calls REST", async () => {
    const before = rig.restCalls.length;
    const rest = makeRest(rig);
    const result = await callTool(rig, rest, {
      persona_id: "p_alpha",
      community_ref: "discord://guild:1/channel:2",
      content: "hello discord",
      idempotency_key: "ik-1",
    });

    expect(result.status).toBe("ok");
    expect(result.idempotency_key).toBe("ik-1");
    expect(result.platform_response_id).toMatch(/^mcp-msg-/);

    const newCalls = rig.restCalls.slice(before);
    expect(newCalls).toHaveLength(1);
    expect(newCalls[0].token).toBe(rig.bot_token_sentinel);
    expect(newCalls[0].channelId).toBe("2");
    expect(newCalls[0].content).toBe("hello discord");
  });

  it("never echoes the bot token in the VerbResult", async () => {
    const rest = makeRest(rig);
    const result = await callTool(rig, rest, {
      persona_id: "p_alpha",
      community_ref: "discord://guild:1/channel:2",
      content: "x",
      idempotency_key: "ik-2",
    });
    expect(JSON.stringify(result)).not.toContain(rig.bot_token_sentinel);
  });

  it("returns failed status (not throw) when persona is unknown", async () => {
    const rest = makeRest(rig);
    const result = await callTool(rig, rest, {
      persona_id: "ghost",
      community_ref: "discord://guild:1/channel:2",
      content: "x",
      idempotency_key: "ik-3",
    });
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(rig.bot_token_sentinel);
  });

  it("returns failed status for malformed discord ref", async () => {
    const rest = makeRest(rig);
    const result = await callTool(rig, rest, {
      persona_id: "p_alpha",
      community_ref: "discord://garbage",
      content: "x",
      idempotency_key: "ik-4",
    });
    expect(result.status).toBe("failed");
    expect((result.warnings as string[])[0]).toContain("invalid community_ref");
  });

  // CONSUMPTION-RECOVERY (Patrick's pre-merge concern):
  // After a REST failure consumes a Credential, a follow-up call for the
  // same persona must trigger a fresh vault fetch — never retry against a
  // consumed credential. The proof is in the audit log: 2 calls = 2 audit
  // entries, both for the same persona, with different timestamps.
  it("a retry after a REST failure triggers a fresh vault fetch (audit grows)", async () => {
    const auditBefore = (await readFile(rig.auditPath, "utf8"))
      .split("\n")
      .filter(Boolean).length;

    // First call: REST throws -> Credential is consumed inside .use() finally
    const failingRest = makeRest(rig, { throwAfter: 0 });
    const failed = await callTool(rig, failingRest, {
      persona_id: "p_alpha",
      community_ref: "discord://guild:1/channel:2",
      content: "first",
      idempotency_key: "ik-fail",
    });
    expect(failed.status).toBe("failed");

    // Second call (same persona, fresh): must succeed because the child
    // re-fetches from vault every action; no Credential reuse.
    const okRest = makeRest(rig);
    const ok = await callTool(rig, okRest, {
      persona_id: "p_alpha",
      community_ref: "discord://guild:1/channel:2",
      content: "second",
      idempotency_key: "ik-ok",
    });
    expect(ok.status).toBe("ok");

    const auditAfter = await readFile(rig.auditPath, "utf8");
    const lines = auditAfter.split("\n").filter(Boolean);
    // exactly 2 new audit entries from the two calls above
    expect(lines.length - auditBefore).toBe(2);
    const newEntries = lines
      .slice(auditBefore)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(newEntries[0].purpose).toBe("post_to_community:ik-fail");
    expect(newEntries[1].purpose).toBe("post_to_community:ik-ok");
    // and the audit log must not contain the secret
    expect(auditAfter).not.toContain(rig.bot_token_sentinel);
  });
});
