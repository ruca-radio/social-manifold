import { describe, it, expect } from "vitest";
import {
  RateLimitAccountant,
  type CadenceLoader,
} from "../src/ratelimit/accountant.js";

const loader = (cadence: [number, number]): CadenceLoader => ({
  async cadenceMinutes() {
    return cadence;
  },
});

describe("RateLimitAccountant", () => {
  it("first call for a persona is allowed", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const r = await acc.checkAndReserve("p1", "discord", 1_000_000);
    expect(r.allowed).toBe(true);
  });

  it("a second call within the persona min cadence is denied with retry_after", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const t0 = 1_000_000;
    const ok = await acc.checkAndReserve("p1", "discord", t0);
    expect(ok.allowed).toBe(true);
    const denied = await acc.checkAndReserve("p1", "discord", t0 + 5 * 60_000);
    expect(denied.allowed).toBe(false);
    expect(denied.retry_after_seconds).toBeGreaterThan(0);
    expect(denied.retry_after_seconds).toBeLessThanOrEqual(300);
  });

  it("a second call past the persona min cadence is allowed", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const t0 = 1_000_000;
    await acc.checkAndReserve("p1", "discord", t0);
    const r = await acc.checkAndReserve("p1", "discord", t0 + 11 * 60_000);
    expect(r.allowed).toBe(true);
  });

  it("denied calls do NOT consume the slot — third call still has accurate retry_after", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const t0 = 1_000_000;
    await acc.checkAndReserve("p1", "discord", t0);
    await acc.checkAndReserve("p1", "discord", t0 + 1_000); // denied
    const third = await acc.checkAndReserve("p1", "discord", t0 + 2_000);
    expect(third.allowed).toBe(false);
    expect(third.retry_after_seconds).toBeGreaterThan(595);
  });

  it("recordPlatformBackoff sets a backoff that beats the cadence floor", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const t0 = 1_000_000;
    await acc.checkAndReserve("p1", "discord", t0);
    acc.recordPlatformBackoff("p1", "discord", 30 * 60, t0);
    const r = await acc.checkAndReserve("p1", "discord", t0 + 11 * 60_000);
    expect(r.allowed).toBe(false);
    expect(r.retry_after_seconds).toBeGreaterThan(60 * 18);
  });

  it("after backoff expires AND cadence floor is past, the next call is allowed", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const t0 = 1_000_000;
    await acc.checkAndReserve("p1", "discord", t0);
    acc.recordPlatformBackoff("p1", "discord", 30 * 60, t0);
    const r = await acc.checkAndReserve("p1", "discord", t0 + 31 * 60_000);
    expect(r.allowed).toBe(true);
  });

  it("isolates state by (persona_id, platform)", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const t0 = 1_000_000;
    await acc.checkAndReserve("p1", "discord", t0);
    const a = await acc.checkAndReserve("p2", "discord", t0);
    expect(a.allowed).toBe(true);
    const b = await acc.checkAndReserve("p1", "reddit", t0);
    expect(b.allowed).toBe(true);
  });

  it("recordSuccessfulCall is idempotent at the same instant (defensive)", async () => {
    const acc = new RateLimitAccountant(loader([10, 30]));
    const t0 = 1_000_000;
    await acc.checkAndReserve("p1", "discord", t0);
    acc.recordSuccessfulCall("p1", "discord", t0);
    const r = await acc.checkAndReserve("p1", "discord", t0 + 11 * 60_000);
    expect(r.allowed).toBe(true);
  });
});
