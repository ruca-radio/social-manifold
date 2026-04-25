import { randomUUID } from "node:crypto";
import type {
  PostToCommunityInput,
  VerbResult,
} from "@social-manifold/contracts";
import { getScheme } from "../router/route-by-uri.js";
import { DiscordChildClient } from "../child-clients/discord.js";

export interface PostToCommunityDeps {
  discord: DiscordChildClient;
}

export async function postToCommunity(
  input: PostToCommunityInput,
  deps: PostToCommunityDeps,
): Promise<VerbResult> {
  const idempotencyKey = input.idempotency_key ?? randomUUID();
  const scheme = getScheme(input.community_ref);

  if (scheme === null) {
    return {
      status: "failed",
      platform_response_id: null,
      idempotency_key: idempotencyKey,
      telemetry_span_id: null,
      warnings: [`unrecognized community_ref scheme: ${input.community_ref}`],
    };
  }

  if (scheme === "discord") {
    try {
      // Forward the verb to the discord child MCP. The child parses the
      // URI sub-format itself, fetches creds from vault, and returns its
      // own VerbResult; we pass it through with the idempotency_key we
      // generated (or that the caller supplied).
      return await deps.discord.postToCommunity({
        ...input,
        idempotency_key: idempotencyKey,
      });
    } catch (err) {
      return {
        status: "failed",
        platform_response_id: null,
        idempotency_key: idempotencyKey,
        telemetry_span_id: null,
        warnings: [(err as Error).message],
      };
    }
  }

  return {
    status: "failed",
    platform_response_id: null,
    idempotency_key: idempotencyKey,
    telemetry_span_id: null,
    warnings: [`unsupported platform: ${scheme}`],
  };
}
