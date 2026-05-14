import type { RedditRestPort } from "./deps.js";

export class RateLimitedError extends Error {
  constructor(public readonly retry_after_seconds: number) {
    super(`reddit rate limited; retry after ${retry_after_seconds}s`);
    this.name = "RateLimitedError";
  }
}

const TITLE_MAX = 300;

export interface DerivedContent {
  title: string;
  text: string;
}

/**
 * Derive Reddit title+body from a single content blob (Plan 5 D4).
 *   "Title\n\nBody"  → { title: "Title", text: "Body" }
 *   "Title\nBody"    → { title: "Title", text: "Body" }
 *   "single line"    → { title: "single line", text: "" }
 *   long single line → title truncated to 300, overflow → text
 */
export function deriveTitleAndBody(content: string): DerivedContent {
  const paraIdx = content.indexOf("\n\n");
  if (paraIdx >= 0) {
    return {
      title: content.slice(0, paraIdx).slice(0, TITLE_MAX),
      text: content.slice(paraIdx + 2),
    };
  }
  const lineIdx = content.indexOf("\n");
  if (lineIdx >= 0) {
    return {
      title: content.slice(0, lineIdx).slice(0, TITLE_MAX),
      text: content.slice(lineIdx + 1),
    };
  }
  if (content.length <= TITLE_MAX) {
    return { title: content, text: "" };
  }
  return {
    title: content.slice(0, TITLE_MAX),
    text: content.slice(TITLE_MAX),
  };
}

export interface PostSelfInput {
  subreddit: string;
  content: string;
}

export interface PostSelfResult {
  permalink: string;
}

export async function postSelf(
  rest: RedditRestPort,
  accessToken: string,
  input: PostSelfInput,
): Promise<PostSelfResult> {
  const { title, text } = deriveTitleAndBody(input.content);
  return rest.submit(accessToken, {
    subreddit: input.subreddit,
    title,
    text,
  });
}
