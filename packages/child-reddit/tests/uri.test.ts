import { describe, it, expect } from "vitest";
import { parseRedditRef } from "../src/uri.js";

describe("parseRedditRef", () => {
  it("parses a valid subreddit ref", () => {
    expect(parseRedditRef("reddit://r/selfhosted")).toEqual({
      subreddit: "selfhosted",
    });
  });

  it("accepts underscore in subreddit names", () => {
    expect(parseRedditRef("reddit://r/local_llm")).toEqual({
      subreddit: "local_llm",
    });
  });

  it("rejects names shorter than 3 chars", () => {
    expect(parseRedditRef("reddit://r/ab")).toBeNull();
  });

  it("rejects names longer than 21 chars", () => {
    expect(parseRedditRef(`reddit://r/${"x".repeat(22)}`)).toBeNull();
  });

  it("rejects non-alphanumeric (other than underscore)", () => {
    expect(parseRedditRef("reddit://r/has-dash")).toBeNull();
    expect(parseRedditRef("reddit://r/has space")).toBeNull();
  });

  it("rejects malformed schemes", () => {
    expect(parseRedditRef("reddit://comments/abc")).toBeNull();
    expect(parseRedditRef("not-reddit://r/foo")).toBeNull();
    expect(parseRedditRef("")).toBeNull();
  });

  it("rejects comment-thread refs (reserved for reply_to_thread)", () => {
    expect(parseRedditRef("reddit://r/selfhosted/comments/abc123")).toBeNull();
  });
});
