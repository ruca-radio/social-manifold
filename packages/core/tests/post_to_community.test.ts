import { describe, it, expect } from "vitest";
import { postToCommunity } from "../src/verbs/post_to_community.js";

describe("postToCommunity (stub)", () => {
  it("echoes input as a VerbResult with status 'echoed'", async () => {
    const result = await postToCommunity({
      persona_id: "persona_alpha",
      community_ref: "discord://guild:123/channel:456",
      content: "hello world",
      idempotency_key: "test-key-1",
    });
    expect(result.status).toBe("echoed");
    expect(result.idempotency_key).toBe("test-key-1");
    expect(result.platform_response_id).toBeNull();
    expect(result.telemetry_span_id).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("generates a UUID idempotency_key when none is supplied", async () => {
    const result = await postToCommunity({
      persona_id: "persona_alpha",
      community_ref: "discord://guild:123/channel:456",
      content: "hello",
    });
    expect(result.idempotency_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
