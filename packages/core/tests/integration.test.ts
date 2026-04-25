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

interface RestCall {
  channelId: string;
  content: string;
  token: string;
}

interface Rig {
  vault: Server;
  child: Server;
  childPort: number;
  restCalls: RestCall[];
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

  const restCalls: RestCall[] = [];
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
    const discord = new DiscordChildClient({
      host: "127.0.0.1",
      port: rig.childPort,
    });
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
    const textBlock = (
      callResult.content as { type: string; text: string }[]
    )[0];
    const payload = JSON.parse(textBlock.text);

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
