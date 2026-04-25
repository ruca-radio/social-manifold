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
