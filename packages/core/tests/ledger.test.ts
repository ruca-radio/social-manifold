import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdempotencyLedger } from "../src/idempotency/ledger.js";
import type { VerbResult } from "@social-manifold/contracts";

const SAMPLE: VerbResult = {
  status: "ok",
  platform_response_id: "msg-1",
  idempotency_key: "k1",
  telemetry_span_id: null,
  warnings: [],
};

describe("IdempotencyLedger", () => {
  let dir: string;
  let ledger: IdempotencyLedger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-"));
    ledger = new IdempotencyLedger(join(dir, "idem.db"));
  });

  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null on lookup of an unknown key", () => {
    expect(ledger.lookup("nope")).toBeNull();
  });

  it("stores and returns a VerbResult by key", () => {
    ledger.record("k1", "p1", "post_to_community", SAMPLE);
    const got = ledger.lookup("k1");
    expect(got).not.toBeNull();
    expect(got!.status).toBe("deduped");
    expect(got!.platform_response_id).toBe("msg-1");
    expect(got!.idempotency_key).toBe("k1");
    expect(got!.warnings.some((w) => w.includes("deduped from"))).toBe(true);
  });

  it("preserves all original fields on a hit (other than status/warnings)", () => {
    const richResult: VerbResult = {
      status: "ok",
      platform_response_id: "msg-2",
      idempotency_key: "k2",
      telemetry_span_id: "span-abc",
      warnings: ["original-warning"],
      platform_rate_limit: { retry_after_seconds: 3 },
    };
    ledger.record("k2", "p1", "post_to_community", richResult);
    const got = ledger.lookup("k2");
    expect(got!.platform_response_id).toBe("msg-2");
    expect(got!.telemetry_span_id).toBe("span-abc");
    expect(got!.platform_rate_limit?.retry_after_seconds).toBe(3);
  });

  it("records and dedups failed results too (no retry-of-failure auto-recovery)", () => {
    const failed: VerbResult = {
      status: "failed",
      platform_response_id: null,
      idempotency_key: "k-fail",
      telemetry_span_id: null,
      warnings: ["original failure reason"],
    };
    ledger.record("k-fail", "p1", "post_to_community", failed);
    const got = ledger.lookup("k-fail");
    expect(got!.status).toBe("deduped");
    expect(
      got!.warnings.some((w) => w.includes("original failure reason")),
    ).toBe(true);
  });

  it("lazy-expires entries past the TTL on lookup", () => {
    const ageingLedger = new IdempotencyLedger(join(dir, "idem2.db"), {
      ttlMs: 10,
    });
    ageingLedger.record("k-old", "p1", "post_to_community", SAMPLE);
    expect(ageingLedger.lookup("k-old")).not.toBeNull();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(ageingLedger.lookup("k-old")).toBeNull();
        expect(ageingLedger.size()).toBe(0);
        ageingLedger.close();
        resolve();
      }, 20);
    });
  });

  it("uniqueness on idempotency_key — re-recording with same key replaces", () => {
    ledger.record("k1", "p1", "post_to_community", SAMPLE);
    const second: VerbResult = {
      ...SAMPLE,
      platform_response_id: "msg-replaced",
    };
    ledger.record("k1", "p1", "post_to_community", second);
    expect(ledger.lookup("k1")!.platform_response_id).toBe("msg-replaced");
  });
});
