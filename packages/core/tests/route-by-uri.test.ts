import { describe, it, expect } from "vitest";
import { parseCommunityRef } from "../src/router/route-by-uri.js";

describe("parseCommunityRef", () => {
  it("parses a valid discord channel ref", () => {
    const r = parseCommunityRef("discord://guild:123/channel:456");
    expect(r).toEqual({
      platform: "discord",
      guild_id: "123",
      channel_id: "456",
    });
  });

  it("returns null for unknown schemes", () => {
    expect(parseCommunityRef("twitter://user/foo")).toBeNull();
    expect(parseCommunityRef("not-a-uri")).toBeNull();
    expect(parseCommunityRef("")).toBeNull();
  });

  it("returns null for malformed discord refs", () => {
    expect(parseCommunityRef("discord://guild:123")).toBeNull();
    expect(parseCommunityRef("discord://channel:456")).toBeNull();
    expect(parseCommunityRef("discord://guild:abc/channel:def")).toBeNull();
  });
});
