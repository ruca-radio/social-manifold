import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VaultClient } from "@social-manifold/persona-vault/client";
import type { VerbResult } from "@social-manifold/contracts";
import { parseRedditRef } from "./uri.js";
import { postSelf, RateLimitedError } from "./adapter.js";
import { AccessTokenCache, type RedditOAuthPort } from "./auth.js";
import type { RedditRestPort } from "./deps.js";

export interface ChildRedditMcpDeps {
  vault: VaultClient;
  oauth: RedditOAuthPort;
  rest: RedditRestPort;
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

export function createChildRedditMcpServer(
  deps: ChildRedditMcpDeps,
): McpServer {
  const cache = new AccessTokenCache(deps.vault, deps.oauth);
  const server = new McpServer({
    name: "social-manifold-child-reddit",
    version: "0.0.1",
  });

  server.registerTool(
    "post_to_community",
    {
      description:
        "Submit a self-post to a subreddit referenced by `reddit://r/<subreddit>`.",
      inputSchema: PostToCommunityShape,
    },
    async (args) => {
      const idempotencyKey = args.idempotency_key ?? randomUUID();
      const ref = parseRedditRef(args.community_ref);

      let result: VerbResult;
      if (!ref) {
        result = failed(
          idempotencyKey,
          `child-reddit: invalid community_ref ${args.community_ref}`,
        );
      } else {
        try {
          const accessToken = await cache.tokenFor(args.persona_id);
          const posted = await postSelf(deps.rest, accessToken, {
            subreddit: ref.subreddit,
            content: args.content,
          });
          result = {
            status: "ok",
            platform_response_id: posted.permalink,
            idempotency_key: idempotencyKey,
            telemetry_span_id: null,
            warnings: [],
          };
        } catch (err) {
          if (err instanceof RateLimitedError) {
            result = {
              status: "failed",
              platform_response_id: null,
              idempotency_key: idempotencyKey,
              telemetry_span_id: null,
              warnings: [
                `reddit rate limited; retry_after_seconds=${err.retry_after_seconds}`,
              ],
              platform_rate_limit: {
                retry_after_seconds: err.retry_after_seconds,
              },
            };
          } else {
            result = failed(idempotencyKey, (err as Error).message);
          }
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}
