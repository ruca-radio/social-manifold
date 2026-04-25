import { describe, it, expect } from "vitest";
import { postToCommunity } from "../src/verbs/post_to_community.js";
import type { DiscordChildClient } from "../src/child-clients/discord.js";
import type { VerbResult } from "@social-manifold/contracts";

interface CallSpy {
  calls: Array<Record<string, unknown>>;
  result?: VerbResult;
  throws?: Error;
}

function fakeDiscord(spy: CallSpy): DiscordChildClient {
  return {
    postToCommunity: async (input: Record<string, unknown>) => {
      spy.calls.push(input);
      if (spy.throws) throw spy.throws;
      return (
        spy.result ?? {
          status: "ok",
          platform_response_id: "msg-1",
          idempotency_key: input.idempotency_key as string,
          telemetry_span_id: null,
          warnings: [],
        }
      );
    },
  } as unknown as DiscordChildClient;
}

describe("postToCommunity", () => {
  it("forwards a discord:// ref to the discord child and returns its VerbResult", async () => {
    const spy: CallSpy = { calls: [] };
    const result = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "hi",
        idempotency_key: "k1",
      },
      { discord: fakeDiscord(spy) },
    );

    expect(result.status).toBe("ok");
    expect(result.platform_response_id).toBe("msg-1");
    expect(result.idempotency_key).toBe("k1");
    expect(result.warnings).toEqual([]);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].community_ref).toBe("discord://guild:111/channel:222");
    expect(spy.calls[0].content).toBe("hi");
    expect(spy.calls[0].idempotency_key).toBe("k1");
  });

  it("generates an idempotency_key when none is supplied", async () => {
    const spy: CallSpy = { calls: [] };
    const result = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "hi",
      },
      { discord: fakeDiscord(spy) },
    );
    expect(result.idempotency_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(spy.calls[0].idempotency_key).toBe(result.idempotency_key);
  });

  it("returns failed status with a warning for non-URI refs", async () => {
    const spy: CallSpy = { calls: [] };
    const result = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "not-a-uri",
        content: "hi",
        idempotency_key: "k1",
      },
      { discord: fakeDiscord(spy) },
    );
    expect(result.status).toBe("failed");
    expect(result.warnings[0]).toContain("unrecognized community_ref");
    expect(spy.calls).toEqual([]);
  });

  it("returns failed status for an unsupported scheme", async () => {
    const spy: CallSpy = { calls: [] };
    const result = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "twitter://user/foo",
        content: "hi",
        idempotency_key: "k1",
      },
      { discord: fakeDiscord(spy) },
    );
    expect(result.status).toBe("failed");
    expect(result.warnings[0]).toContain("unsupported platform");
    expect(spy.calls).toEqual([]);
  });

  it("returns failed status when the child throws", async () => {
    const spy: CallSpy = {
      calls: [],
      throws: new Error("child mcp call failed"),
    };
    const result = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "hi",
        idempotency_key: "k1",
      },
      { discord: fakeDiscord(spy) },
    );
    expect(result.status).toBe("failed");
    expect(result.warnings[0]).toContain("child mcp call failed");
  });
});
