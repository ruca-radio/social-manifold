import { randomUUID } from "node:crypto";
import type {
  PostToCommunityInput,
  VerbResult,
} from "@social-manifold/contracts";
import { getScheme } from "../router/route-by-uri.js";
import { DiscordChildClient } from "../child-clients/discord.js";
import { RedditChildClient } from "../child-clients/reddit.js";
import { IdempotencyLedger } from "../idempotency/ledger.js";
import { RateLimitAccountant } from "../ratelimit/accountant.js";

export interface PostToCommunityDeps {
  discord: DiscordChildClient;
  reddit: RedditChildClient;
  ledger: IdempotencyLedger;
  accountant: RateLimitAccountant;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

interface ChildClient {
  postToCommunity(input: PostToCommunityInput): Promise<VerbResult>;
}

export async function postToCommunity(
  input: PostToCommunityInput,
  deps: PostToCommunityDeps,
): Promise<VerbResult> {
  const idempotencyKey = input.idempotency_key ?? randomUUID();
  const now = deps.now ?? (() => Date.now());

  if (input.idempotency_key) {
    const cached = deps.ledger.lookup(idempotencyKey);
    if (cached) return cached;
  }

  const scheme = getScheme(input.community_ref);
  if (scheme === null) {
    return failed(
      idempotencyKey,
      `unrecognized community_ref scheme: ${input.community_ref}`,
    );
  }

  const child = pickChild(scheme, deps);
  if (!child) {
    return failed(idempotencyKey, `unsupported platform: ${scheme}`);
  }

  // Per-platform accountant key — Plan 5 cleanup. Plan 4 hardcoded "discord";
  // with reddit added, that would have collapsed both platforms onto a single
  // rate-limit slot per persona. Use the actual scheme.
  const reservation = await deps.accountant.checkAndReserve(
    input.persona_id,
    scheme,
    now(),
  );
  if (!reservation.allowed) {
    return failed(
      idempotencyKey,
      `rate-limited: retry_after_seconds=${reservation.retry_after_seconds}`,
    );
  }

  let childResult: VerbResult;
  try {
    childResult = await child.postToCommunity({
      ...input,
      idempotency_key: idempotencyKey,
    });
  } catch (err) {
    childResult = failed(idempotencyKey, (err as Error).message);
  }

  if (childResult.platform_rate_limit) {
    deps.accountant.recordPlatformBackoff(
      input.persona_id,
      scheme,
      childResult.platform_rate_limit.retry_after_seconds,
      now(),
    );
  }

  deps.ledger.record(
    idempotencyKey,
    input.persona_id,
    "post_to_community",
    childResult,
  );

  return childResult;
}

function pickChild(
  scheme: string,
  deps: PostToCommunityDeps,
): ChildClient | null {
  switch (scheme) {
    case "discord":
      return deps.discord;
    case "reddit":
      return deps.reddit;
    default:
      return null;
  }
}

function failed(idempotencyKey: string, warning: string): VerbResult {
  return {
    status: "failed",
    platform_response_id: null,
    idempotency_key: idempotencyKey,
    telemetry_span_id: null,
    warnings: [warning],
  };
}
