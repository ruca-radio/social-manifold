import { describe, it, expect } from "vitest";
import { postToCommunity } from "../src/verbs/post_to_community.js";
import type { DiscordChildClient } from "../src/child-clients/discord.js";

interface CallSpy {
  calls: Array<Record<string, unknown>>;
  result?: { message_id: string; channel_id: string };
  throws?: Error;
}

function fakeDiscord(spy: CallSpy): DiscordChildClient {
  return {
    postMessage: async (payload: Record<string, unknown>) => {
      spy.calls.push(payload);
      if (spy.throws) throw spy.throws;
      return (
        spy.result ?? {
          message_id: "msg-1",
          channel_id: payload.channel_id as string,
        }
      );
    },
  } as unknown as DiscordChildClient;
}

describe("postToCommunity", () => {
  it("routes a discord:// ref to the discord child and returns ok status", async () => {
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
    expect(spy.calls[0].guild_id).toBe("111");
    expect(spy.calls[0].channel_id).toBe("222");
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
  });

  it("returns failed status with a warning for unrecognized schemes", async () => {
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
    expect(result.platform_response_id).toBeNull();
    expect(result.warnings[0]).toContain("unrecognized community_ref");
    expect(spy.calls).toEqual([]);
  });

  it("returns failed status when the child throws", async () => {
    const spy: CallSpy = {
      calls: [],
      throws: new Error("discord 503"),
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
    expect(result.platform_response_id).toBeNull();
    expect(result.warnings[0]).toContain("discord 503");
  });
});
