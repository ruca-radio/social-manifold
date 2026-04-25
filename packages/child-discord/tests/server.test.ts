import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createVaultServer } from "@social-manifold/persona-vault";
import { VaultClient } from "@social-manifold/persona-vault/client";
import type { Server } from "node:http";
import { createChildDiscordServer } from "../src/server.js";
import type { DiscordRestPort } from "../src/deps.js";

const exec = promisify(execFile);

interface CallSpy {
  calls: Array<{ channelId: string; content: string; token: string }>;
}

interface Rig {
  childPort: number;
  vaultServer: Server;
  childServer: Server;
  restCalls: CallSpy["calls"];
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
  await writeFile(credPath, `discord:\n  bot_token: ${SENTINEL}\n`, "utf8");
  await exec("sops", ["--encrypt", "--age", recipient, "--in-place", credPath]);

  const socketPath = join(tmp, "v.sock");
  const vaultServer = await createVaultServer({
    personasRoot,
    auditPath: join(tmp, "audit.jsonl"),
    ageKeyPath: ageKey,
    socketPath,
  });

  const restCalls: CallSpy["calls"] = [];
  const fakeRest: DiscordRestPort = {
    async postMessage(channelId, content, token) {
      restCalls.push({ channelId, content, token });
      return { id: "fake-message-id-42" };
    },
  };

  const vault = new VaultClient(socketPath);
  const childServer = await createChildDiscordServer({
    port: 0,
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
    expect(JSON.stringify(res.body)).not.toContain(rig.bot_token_sentinel);
  });

  it("returns 400 on missing required fields", async () => {
    const res = await tcpReq(rig.childPort, "POST", "/v1/post-message", {
      persona_id: "p_alpha",
    });
    expect(res.status).toBe(400);
  });
});
