import { randomUUID } from "node:crypto";
import type {
  PostToCommunityInput,
  VerbResult,
} from "@social-manifold/contracts";
import { parseCommunityRef } from "../router/route-by-uri.js";
import { DiscordChildClient } from "../child-clients/discord.js";

export interface PostToCommunityDeps {
  discord: DiscordChildClient;
}

export async function postToCommunity(
  input: PostToCommunityInput,
  deps: PostToCommunityDeps,
): Promise<VerbResult> {
  const idempotencyKey = input.idempotency_key ?? randomUUID();
  const ref = parseCommunityRef(input.community_ref);

  if (!ref) {
    return {
      status: "failed",
      platform_response_id: null,
      idempotency_key: idempotencyKey,
      telemetry_span_id: null,
      warnings: [`unrecognized community_ref scheme: ${input.community_ref}`],
    };
  }

  if (ref.platform === "discord") {
    try {
      const result = await deps.discord.postMessage({
        persona_id: input.persona_id,
        guild_id: ref.guild_id,
        channel_id: ref.channel_id,
        content: input.content,
        idempotency_key: idempotencyKey,
      });
      return {
        status: "ok",
        platform_response_id: result.message_id,
        idempotency_key: idempotencyKey,
        telemetry_span_id: null,
        warnings: [],
      };
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
    warnings: [
      `unsupported platform: ${(ref as { platform: string }).platform}`,
    ],
  };
}
