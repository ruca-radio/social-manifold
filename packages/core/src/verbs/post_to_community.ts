import { randomUUID } from "node:crypto";
import type { PostToCommunityInput, VerbResult } from "../types.js";

export async function postToCommunity(
  input: PostToCommunityInput,
): Promise<VerbResult> {
  return {
    status: "echoed",
    platform_response_id: null,
    idempotency_key: input.idempotency_key ?? randomUUID(),
    telemetry_span_id: null,
    warnings: [],
  };
}
