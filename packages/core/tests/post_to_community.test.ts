import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postToCommunity } from "../src/verbs/post_to_community.js";
import { IdempotencyLedger } from "../src/idempotency/ledger.js";
import {
  RateLimitAccountant,
  type CadenceLoader,
} from "../src/ratelimit/accountant.js";
import type { DiscordChildClient } from "../src/child-clients/discord.js";
import type { RedditChildClient } from "../src/child-clients/reddit.js";
import type { VerbResult } from "@social-manifold/contracts";

const cadence = (mins: [number, number]): CadenceLoader => ({
  async cadenceMinutes() {
    return mins;
  },
});

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

function fakeReddit(spy: CallSpy): RedditChildClient {
  return {
    postToCommunity: async (input: Record<string, unknown>) => {
      spy.calls.push(input);
      if (spy.throws) throw spy.throws;
      return (
        spy.result ?? {
          status: "ok",
          platform_response_id: "/r/x/comments/y/z/",
          idempotency_key: input.idempotency_key as string,
          telemetry_span_id: null,
          warnings: [],
        }
      );
    },
  } as unknown as RedditChildClient;
}

const stubReddit = {
  postToCommunity: async () => {
    throw new Error("reddit not used in this test");
  },
} as unknown as RedditChildClient;

describe("postToCommunity (with ledger + accountant)", () => {
  let dir: string;
  let ledger: IdempotencyLedger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "p2c-"));
    ledger = new IdempotencyLedger(join(dir, "idem.db"));
    return () => {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    };
  });

  it("forwards a fresh discord:// call to the child and records in ledger", async () => {
    const spy: CallSpy = { calls: [] };
    const acc = new RateLimitAccountant(cadence([0, 0]));
    const result = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "hi",
        idempotency_key: "k1",
      },
      { discord: fakeDiscord(spy), reddit: stubReddit, ledger, accountant: acc, now: () => 0 },
    );
    expect(result.status).toBe("ok");
    expect(spy.calls).toHaveLength(1);
    expect(ledger.lookup("k1")?.status).toBe("deduped");
  });

  it("returns deduped on a second call with the same key — child NOT called again", async () => {
    const spy: CallSpy = { calls: [] };
    const acc = new RateLimitAccountant(cadence([0, 0]));
    const args = {
      persona_id: "p1",
      community_ref: "discord://guild:111/channel:222",
      content: "hi",
      idempotency_key: "k-dup",
    };
    const a = await postToCommunity(args, {
      discord: fakeDiscord(spy),
      reddit: stubReddit,
      ledger,
      accountant: acc,
      now: () => 0,
    });
    const b = await postToCommunity(args, {
      discord: fakeDiscord(spy),
      reddit: stubReddit,
      ledger,
      accountant: acc,
      now: () => 1000,
    });
    expect(a.status).toBe("ok");
    expect(b.status).toBe("deduped");
    expect(spy.calls).toHaveLength(1);
    expect(b.platform_response_id).toBe(a.platform_response_id);
    expect(b.warnings.some((w) => w.includes("deduped from"))).toBe(true);
  });

  it("returns failed with retry_after when persona is rate-limited", async () => {
    const spy: CallSpy = { calls: [] };
    const acc = new RateLimitAccountant(cadence([10, 30]));
    const t0 = 1_000_000;

    const first = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "first",
        idempotency_key: "k-a",
      },
      { discord: fakeDiscord(spy), reddit: stubReddit, ledger, accountant: acc, now: () => t0 },
    );
    expect(first.status).toBe("ok");

    const second = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "second",
        idempotency_key: "k-b",
      },
      {
        discord: fakeDiscord(spy),
        ledger,
        accountant: acc,
        now: () => t0 + 5 * 60_000,
      },
    );
    expect(second.status).toBe("failed");
    expect(spy.calls).toHaveLength(1);
    expect(second.warnings.some((w) => /retry_after_seconds=\d+/.test(w))).toBe(
      true,
    );
    // rate-limit-rejected calls are NOT cached in the ledger
    expect(ledger.lookup("k-b")).toBeNull();
  });

  it("records platform_rate_limit feedback into the accountant", async () => {
    const spy: CallSpy = {
      calls: [],
      result: {
        status: "ok",
        platform_response_id: "msg-x",
        idempotency_key: "k-x",
        telemetry_span_id: null,
        warnings: [],
        platform_rate_limit: { retry_after_seconds: 1800 },
      },
    };
    const acc = new RateLimitAccountant(cadence([1, 5]));
    const t0 = 2_000_000;

    const first = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "x",
        idempotency_key: "k-x",
      },
      { discord: fakeDiscord(spy), reddit: stubReddit, ledger, accountant: acc, now: () => t0 },
    );
    expect(first.status).toBe("ok");
    expect(first.platform_rate_limit?.retry_after_seconds).toBe(1800);

    // 5 minutes later — past 1-min cadence, but inside 30-min platform backoff
    const second = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "y",
        idempotency_key: "k-y",
      },
      {
        discord: fakeDiscord(spy),
        ledger,
        accountant: acc,
        now: () => t0 + 5 * 60_000,
      },
    );
    expect(second.status).toBe("failed");
    expect(second.warnings.some((w) => /retry_after_seconds=\d+/.test(w))).toBe(
      true,
    );
  });

  it("records failed child responses in the ledger", async () => {
    const spy: CallSpy = { calls: [], throws: new Error("child died") };
    const acc = new RateLimitAccountant(cadence([0, 0]));
    const a = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "x",
        idempotency_key: "k-fail",
      },
      { discord: fakeDiscord(spy), reddit: stubReddit, ledger, accountant: acc, now: () => 0 },
    );
    expect(a.status).toBe("failed");
    const b = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:111/channel:222",
        content: "x",
        idempotency_key: "k-fail",
      },
      { discord: fakeDiscord(spy), reddit: stubReddit, ledger, accountant: acc, now: () => 1000 },
    );
    expect(b.status).toBe("deduped");
    expect(spy.calls).toHaveLength(1);
  });

  it("routes a reddit:// ref to the reddit child (not discord)", async () => {
    const dSpy: CallSpy = { calls: [] };
    const rSpy: CallSpy = { calls: [] };
    const acc = new RateLimitAccountant(cadence([0, 0]));
    const result = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "reddit://r/selfhosted",
        content: "hi",
        idempotency_key: "k-r",
      },
      {
        discord: fakeDiscord(dSpy),
        reddit: fakeReddit(rSpy),
        ledger,
        accountant: acc,
        now: () => 0,
      },
    );
    expect(result.status).toBe("ok");
    expect(result.platform_response_id).toBe("/r/x/comments/y/z/");
    expect(dSpy.calls).toEqual([]);
    expect(rSpy.calls).toHaveLength(1);
  });

  // Plan 5 cleanup of the Plan 4 hardcoded "discord" accountant key.
  // Without this fix, a discord call would consume the persona's slot for
  // BOTH discord and reddit. With per-platform isolation, posting to discord
  // does not affect reddit's rate-limit window for the same persona.
  it("isolates rate-limit state across platforms", async () => {
    const dSpy: CallSpy = { calls: [] };
    const rSpy: CallSpy = { calls: [] };
    const acc = new RateLimitAccountant(cadence([10, 30]));
    const t0 = 1_000_000;

    const a = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "discord://guild:1/channel:2",
        content: "x",
        idempotency_key: "ka",
      },
      {
        discord: fakeDiscord(dSpy),
        reddit: fakeReddit(rSpy),
        ledger,
        accountant: acc,
        now: () => t0,
      },
    );
    expect(a.status).toBe("ok");

    // Immediately post to reddit — must NOT be blocked by discord's cadence.
    const b = await postToCommunity(
      {
        persona_id: "p1",
        community_ref: "reddit://r/selfhosted",
        content: "x",
        idempotency_key: "kb",
      },
      {
        discord: fakeDiscord(dSpy),
        reddit: fakeReddit(rSpy),
        ledger,
        accountant: acc,
        now: () => t0 + 1,
      },
    );
    expect(b.status).toBe("ok");
    expect(rSpy.calls).toHaveLength(1);
  });
});
