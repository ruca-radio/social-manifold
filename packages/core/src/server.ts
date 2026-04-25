import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DiscordChildClient } from "./child-clients/discord.js";
import { IdempotencyLedger } from "./idempotency/ledger.js";
import { RateLimitAccountant } from "./ratelimit/accountant.js";
import { IdentityLoader } from "./ratelimit/identity-loader.js";
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
  ledger: IdempotencyLedger;
  accountant: RateLimitAccountant;
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
      const result = await postToCommunity(args, {
        discord: opts.discord,
        ledger: opts.ledger,
        accountant: opts.accountant,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const discordSocket =
    process.env.CHILD_DISCORD_SOCKET_PATH ??
    "/run/social-manifold/children/discord.sock";
  const ledgerPath =
    process.env.CORE_IDEMPOTENCY_DB ??
    "/var/lib/social-manifold/idempotency.db";
  const personasRoot =
    process.env.CORE_PERSONAS_ROOT ?? "/var/social-manifold/personas";

  const discord = new DiscordChildClient({ socketPath: discordSocket });
  const ledger = new IdempotencyLedger(ledgerPath);
  const accountant = new RateLimitAccountant(new IdentityLoader(personasRoot));

  const server = createServer({ discord, ledger, accountant });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
