import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

describe("MCP server", () => {
  it("lists post_to_community as a tool and returns an echoed VerbResult", async () => {
    const server = createServer();
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
        persona_id: "persona_alpha",
        community_ref: "discord://guild:1/channel:2",
        content: "hi",
        idempotency_key: "k1",
      },
    });

    const textBlock = (callResult.content as { type: string; text: string }[])[0];
    const payload = JSON.parse(textBlock.text);
    expect(payload.status).toBe("echoed");
    expect(payload.idempotency_key).toBe("k1");
    expect(payload.platform_response_id).toBeNull();

    await client.close();
    await server.close();
  });
});
