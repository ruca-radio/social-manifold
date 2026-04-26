import { Agent, fetch as undiciFetch } from "undici";
import { RateLimitedError } from "./adapter.js";

export interface RedditSubmitInput {
  subreddit: string;
  title: string;
  text: string;
}

export interface RedditSubmitResult {
  permalink: string;
}

export interface RedditRestPort {
  submit(
    accessToken: string,
    input: RedditSubmitInput,
  ): Promise<RedditSubmitResult>;
}

export interface RedditOAuthLivePort {
  exchangeRefreshToken(input: {
    client_id: string;
    client_secret: string;
    refresh_token: string;
  }): Promise<{ access_token: string; expires_in: number }>;
}

const USER_AGENT =
  "social-manifold/0.0.1 (+https://github.com/ruca-radio/social-manifold)";

/** Production REST adapter — direct calls to oauth.reddit.com. */
export const liveRedditRest: RedditRestPort = {
  async submit(accessToken, input) {
    const body = new URLSearchParams({
      api_type: "json",
      kind: "self",
      sr: input.subreddit,
      title: input.title,
      text: input.text,
    });
    const res = await undiciFetch("https://oauth.reddit.com/api/submit", {
      method: "POST",
      headers: {
        authorization: `bearer ${accessToken}`,
        "user-agent": USER_AGENT,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (res.status === 429) {
      const retry =
        res.headers.get("x-ratelimit-reset") ?? res.headers.get("retry-after");
      const seconds = retry ? parseInt(retry, 10) : 60;
      throw new RateLimitedError(Number.isFinite(seconds) ? seconds : 60);
    }
    if (!res.ok) {
      throw new Error(`reddit submit ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      json: { data?: { url?: string }; errors?: unknown[] };
    };
    if (json.json.errors && json.json.errors.length > 0) {
      throw new Error(
        `reddit submit errors: ${JSON.stringify(json.json.errors)}`,
      );
    }
    return { permalink: json.json.data?.url ?? "" };
  },
};

const DUAL_AGENT = new Agent({
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 60_000,
});

/** Production OAuth port — exchanges refresh_token for access_token. */
export const liveRedditOAuth: RedditOAuthLivePort = {
  async exchangeRefreshToken({ client_id, client_secret, refresh_token }) {
    const basic = Buffer.from(`${client_id}:${client_secret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token,
    });
    const res = await undiciFetch(
      "https://www.reddit.com/api/v1/access_token",
      {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "user-agent": USER_AGENT,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        dispatcher: DUAL_AGENT,
      },
    );
    if (!res.ok) {
      throw new Error(`reddit oauth ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    return { access_token: json.access_token, expires_in: json.expires_in };
  },
};
