import { randomUUID } from "node:crypto";
import type {
  PostToCommunityInput,
  VerbResult,
} from "@social-manifold/contracts";
import { getScheme } from "../router/route-by-uri.js";
import { DiscordChildClient } from "../child-clients/discord.js";
import { IdempotencyLedger } from "../idempotency/ledger.js";
import { RateLimitAccountant } from "../ratelimit/accountant.js";

export interface PostToCommunityDeps {
  discord: DiscordChildClient;
  ledger: IdempotencyLedger;
  accountant: RateLimitAccountant;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export async function postToCommunity(
  input: PostToCommunityInput,
  deps: PostToCommunityDeps,
): Promise<VerbResult> {
  const idempotencyKey = input.idempotency_key ?? randomUUID();
  const now = deps.now ?? (() => Date.now());

  // 1. dedup check (only if caller supplied a key — generated UUIDs would
  //    never hit, so the lookup is a free no-op then)
  if (input.idempotency_key) {
    const cached = deps.ledger.lookup(idempotencyKey);
    if (cached) return cached;
  }

  // 2. parse + route by scheme
  const scheme = getScheme(input.community_ref);
  if (scheme === null) {
    return failed(
      idempotencyKey,
      `unrecognized community_ref scheme: ${input.community_ref}`,
    );
  }
  if (scheme !== "discord") {
    return failed(idempotencyKey, `unsupported platform: ${scheme}`);
  }

  // 3. rate-limit check (per-persona behavioral + platform backoff). NOT
  //    cached in the ledger if denied — the operator should retry once the
  //    window opens, with the same key, and that retry should hit.
  const reservation = await deps.accountant.checkAndReserve(
    input.persona_id,
    "discord",
    now(),
  );
  if (!reservation.allowed) {
    return failed(
      idempotencyKey,
      `rate-limited: retry_after_seconds=${reservation.retry_after_seconds}`,
    );
  }

  // 4. forward to child
  let childResult: VerbResult;
  try {
    childResult = await deps.discord.postToCommunity({
      ...input,
      idempotency_key: idempotencyKey,
    });
  } catch (err) {
    childResult = failed(idempotencyKey, (err as Error).message);
  }

  // 5. if child observed a platform-level rate limit, feed it back to the
  //    accountant so future checks respect the backoff
  if (childResult.platform_rate_limit) {
    deps.accountant.recordPlatformBackoff(
      input.persona_id,
      "discord",
      childResult.platform_rate_limit.retry_after_seconds,
      now(),
    );
  }

  // 6. record in ledger so subsequent retries with the same key are deduped
  deps.ledger.record(
    idempotencyKey,
    input.persona_id,
    "post_to_community",
    childResult,
  );

  return childResult;
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
