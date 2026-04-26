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
