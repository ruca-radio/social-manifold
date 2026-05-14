import { describe, it, expect } from "vitest";
import {
  deriveTitleAndBody,
  postSelf,
  RateLimitedError,
} from "../src/adapter.js";
import type { RedditRestPort } from "../src/deps.js";

interface CallSpy {
  calls: Array<{
    accessToken: string;
    subreddit: string;
    title: string;
    text: string;
  }>;
}

function fakeRest(spy: CallSpy): RedditRestPort {
  return {
    async submit(accessToken, input) {
      spy.calls.push({ accessToken, ...input });
      return { permalink: "/r/foo/comments/abc/title/" };
    },
  };
}

describe("deriveTitleAndBody", () => {
  it("splits on the first paragraph break", () => {
    expect(deriveTitleAndBody("Title here\n\nBody here")).toEqual({
      title: "Title here",
      text: "Body here",
    });
  });

  it("uses the whole content as title when single-line and short", () => {
    expect(deriveTitleAndBody("just a title")).toEqual({
      title: "just a title",
      text: "",
    });
  });

  it("truncates a long single-line title to 300 chars and puts overflow in text", () => {
    const long = "x".repeat(310);
    const r = deriveTitleAndBody(long);
    expect(r.title.length).toBe(300);
    expect(r.title).toBe("x".repeat(300));
    expect(r.text).toBe("x".repeat(10));
  });

  it("uses first \\n as title break when no paragraph break", () => {
    expect(deriveTitleAndBody("Title\nbody-line-1\nbody-line-2")).toEqual({
      title: "Title",
      text: "body-line-1\nbody-line-2",
    });
  });
});

describe("postSelf", () => {
  it("submits a self-post with the derived title and body", async () => {
    const spy: CallSpy = { calls: [] };
    const result = await postSelf(fakeRest(spy), "ACCESS-X", {
      subreddit: "selfhosted",
      content: "How I host LLMs at home\n\nI use a 4090 and ...",
    });
    expect(result.permalink).toBe("/r/foo/comments/abc/title/");
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].accessToken).toBe("ACCESS-X");
    expect(spy.calls[0].subreddit).toBe("selfhosted");
    expect(spy.calls[0].title).toBe("How I host LLMs at home");
    expect(spy.calls[0].text).toBe("I use a 4090 and ...");
  });

  it("propagates RateLimitedError", async () => {
    const rest: RedditRestPort = {
      async submit() {
        throw new RateLimitedError(120);
      },
    };
    await expect(
      postSelf(rest, "ACCESS-X", { subreddit: "x", content: "y" }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});
