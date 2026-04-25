export type VerbStatus = "ok" | "echoed" | "deduped" | "failed";

export interface VerbResult {
  status: VerbStatus;
  platform_response_id: string | null;
  idempotency_key: string;
  telemetry_span_id: string | null;
  warnings: string[];
  /**
   * Set by a child when the platform returned a rate-limit signal
   * (e.g. Discord 429 with Retry-After). The core's rate-limit accountant
   * uses this to record backoff for future calls. See CLAUDE.md §4 + §9.
   */
  platform_rate_limit?: { retry_after_seconds: number };
}

export interface MediaRef {
  kind: "image" | "video" | "link";
  url: string;
  alt_text?: string;
}

export interface PostToCommunityInput {
  persona_id: string;
  community_ref: string;
  content: string;
  media?: MediaRef[];
  idempotency_key?: string;
}
