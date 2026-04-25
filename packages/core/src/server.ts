import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DiscordChildClient } from "./child-clients/discord.js";
import { postToCommunity } from "./verbs/post_to_community.js";

const PostToCommunityShape = {
  persona_id: z.string().min(1),
  community_ref: z.string().min(1),
  content: z.string().min(1),
  media: z
    .array(
      z.object({
        kind: z.enum(["image", "video", "link"]),
        url: z.string().url(),
        alt_text: z.string().optional(),
      }),
    )
    .optional(),
  idempotency_key: z.string().optional(),
};

export interface CreateServerOptions {
  discord: DiscordChildClient;
}

export function createServer(opts: CreateServerOptions): McpServer {
  const server = new McpServer({
    name: "social-manifold-core",
    version: "0.0.1",
  });

  server.registerTool(
    "post_to_community",
    {
      description: "Publish original content to a named community/channel.",
      inputSchema: PostToCommunityShape,
    },
    async (args) => {
      const result = await postToCommunity(args, { discord: opts.discord });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const discordHost = process.env.CHILD_DISCORD_HOST ?? "child-discord";
  const discordPort = Number(process.env.CHILD_DISCORD_PORT ?? "7811");
  const discord = new DiscordChildClient({
    host: discordHost,
    port: discordPort,
  });

  const server = createServer({ discord });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
