import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VaultClient } from "@social-manifold/persona-vault/client";
import type { VerbResult } from "@social-manifold/contracts";
import { parseDiscordRef } from "./uri.js";
import { postMessage } from "./adapter.js";
import type { DiscordRestPort } from "./deps.js";

export interface ChildDiscordMcpDeps {
  vault: VaultClient;
  rest: DiscordRestPort;
}

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

function failed(idempotencyKey: string, warning: string): VerbResult {
  return {
    status: "failed",
    platform_response_id: null,
    idempotency_key: idempotencyKey,
    telemetry_span_id: null,
    warnings: [warning],
  };
}

export function createChildDiscordMcpServer(
  deps: ChildDiscordMcpDeps,
): McpServer {
  const server = new McpServer({
    name: "social-manifold-child-discord",
    version: "0.0.1",
  });

  server.registerTool(
    "post_to_community",
    {
      description:
        "Post a message to a Discord channel referenced by `discord://guild:G/channel:C`.",
      inputSchema: PostToCommunityShape,
    },
    async (args) => {
      const idempotencyKey = args.idempotency_key ?? randomUUID();
      const ref = parseDiscordRef(args.community_ref);

      let result: VerbResult;
      if (!ref) {
        result = failed(
          idempotencyKey,
          `child-discord: invalid community_ref ${args.community_ref}`,
        );
      } else {
        try {
          // Per-action credential fetch. A retry from the operator triggers
          // a new vault call (and audit entry); we never reuse a consumed
          // Credential — see Plan 3 D3.
          const cred = await deps.vault.getCredential(
            args.persona_id,
            "discord",
            {
              requester_id: "child-discord",
              purpose: `post_to_community:${idempotencyKey}`,
            },
          );
          const posted = await postMessage(cred, deps.rest, {
            channel_id: ref.channel_id,
            content: args.content,
          });
          result = {
            status: "ok",
            platform_response_id: posted.message_id,
            idempotency_key: idempotencyKey,
            telemetry_span_id: null,
            warnings: [],
          };
        } catch (err) {
          result = failed(idempotencyKey, (err as Error).message);
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}
