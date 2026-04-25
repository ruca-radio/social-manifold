export type VerbStatus = "ok" | "echoed" | "deduped" | "failed";

export interface VerbResult {
  status: VerbStatus;
  platform_response_id: string | null;
  idempotency_key: string;
  telemetry_span_id: string | null;
  warnings: string[];
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
