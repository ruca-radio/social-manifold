import { describe, it, expect } from "vitest";
import { Credential } from "@social-manifold/persona-vault/client";
import { postMessage } from "../src/adapter.js";
import type { DiscordRestPort } from "../src/deps.js";

interface CallSpy {
  calls: Array<{ channelId: string; content: string; token: string }>;
}

function fakeRest(spy: CallSpy): DiscordRestPort {
  return {
    async postMessage(channelId, content, token) {
      spy.calls.push({ channelId, content, token });
      return { id: "msg-12345" };
    },
  };
}

describe("postMessage adapter", () => {
  it("calls REST inside .use() with the decrypted token", async () => {
    const cred = new Credential({ bot_token: "BOT-TOKEN-XYZ" });
    const spy: CallSpy = { calls: [] };
    const result = await postMessage(cred, fakeRest(spy), {
      channel_id: "ch1",
      content: "hello",
    });

    expect(result.message_id).toBe("msg-12345");
    expect(result.channel_id).toBe("ch1");
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].token).toBe("BOT-TOKEN-XYZ");
    expect(spy.calls[0].channelId).toBe("ch1");
    expect(spy.calls[0].content).toBe("hello");
  });

  it("consumes the credential after the call (Credential.use() contract)", async () => {
    const cred = new Credential({ bot_token: "BOT-TOKEN-XYZ" });
    const spy: CallSpy = { calls: [] };
    await postMessage(cred, fakeRest(spy), {
      channel_id: "ch1",
      content: "hi",
    });

    expect(cred.get("bot_token")).toBeUndefined();
    await expect(
      postMessage(cred, fakeRest(spy), { channel_id: "ch1", content: "hi" }),
    ).rejects.toThrow(/already consumed/);
  });

  it("consumes the credential even when REST throws", async () => {
    const cred = new Credential({ bot_token: "BOT-TOKEN-XYZ" });
    const failingRest: DiscordRestPort = {
      async postMessage() {
        throw new Error("discord 503");
      },
    };

    await expect(
      postMessage(cred, failingRest, { channel_id: "ch1", content: "x" }),
    ).rejects.toThrow(/discord 503/);

    expect(cred.get("bot_token")).toBeUndefined();
  });

  it("throws when the credential lacks a bot_token", async () => {
    const cred = new Credential({ application_id: "111" });
    const spy: CallSpy = { calls: [] };
    await expect(
      postMessage(cred, fakeRest(spy), { channel_id: "ch1", content: "x" }),
    ).rejects.toThrow(/bot_token/);
    expect(spy.calls).toHaveLength(0);
  });
});
