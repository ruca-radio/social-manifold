import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Agent, fetch as undiciFetch } from "undici";
import type { RequestInit as UndiciRequestInit } from "undici";
import type {
  PostToCommunityInput,
  VerbResult,
} from "@social-manifold/contracts";

export interface DiscordChildClientConfig {
  socketPath: string;
}

/**
 * MCP client for the discord child, transport: Streamable HTTP over a Unix
 * domain socket (per CLAUDE.md §7.5 — Core ↔ child MCP transport).
 *
 * Connection lifecycle: lazily created on first call, reused for subsequent
 * calls. The client is long-lived (no MCP tear-down per request); the
 * Credential consumption pattern lives below this layer, inside the child.
 */
export class DiscordChildClient {
  #client: Client | null = null;
  #connecting: Promise<Client> | null = null;

  constructor(private readonly cfg: DiscordChildClientConfig) {}

  async #ensureClient(): Promise<Client> {
    if (this.#client) return this.#client;
    if (this.#connecting) return this.#connecting;

    this.#connecting = (async () => {
      const dispatcher = new Agent({
        connect: { socketPath: this.cfg.socketPath },
      });
      const transport = new StreamableHTTPClientTransport(
        new URL("http://child-discord/mcp"),
        {
          fetch: ((url: string | URL, init?: RequestInit) =>
            undiciFetch(url, {
              ...(init as UndiciRequestInit),
              dispatcher,
            }) as unknown as Promise<Response>) as never,
        },
      );
      const client = new Client({
        name: "social-manifold-core",
        version: "0.0.1",
      });
      await client.connect(transport);
      this.#client = client;
      this.#connecting = null;
      return client;
    })();
    return this.#connecting;
  }

  async postToCommunity(input: PostToCommunityInput): Promise<VerbResult> {
    const client = await this.#ensureClient();
    const callResult = await client.callTool({
      name: "post_to_community",
      arguments: input as unknown as Record<string, unknown>,
    });
    const blocks = callResult.content as { type: string; text: string }[];
    if (!blocks?.[0]?.text) {
      throw new Error("child-discord: empty tool response");
    }
    return JSON.parse(blocks[0].text) as VerbResult;
  }

  async close(): Promise<void> {
    if (this.#client) {
      await this.#client.close();
      this.#client = null;
    }
  }
}
