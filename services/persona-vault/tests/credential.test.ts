import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { Credential } from "../src/client/credential.js";

describe("Credential wrapper", () => {
  it("returns the underlying value via .get()", () => {
    const cred = new Credential({ token: "secret-token", api_key: "sk-123" });
    expect(cred.get("token")).toBe("secret-token");
    expect(cred.get("api_key")).toBe("sk-123");
    expect(cred.get("missing")).toBeUndefined();
  });

  it("redacts via toString()", () => {
    const cred = new Credential({ token: "secret-token" });
    expect(String(cred)).toBe("[Credential redacted]");
    expect(`creds: ${cred}`).toBe("creds: [Credential redacted]");
  });

  it("redacts via JSON.stringify()", () => {
    const cred = new Credential({ token: "secret-token" });
    expect(JSON.stringify(cred)).toBe('"[Credential redacted]"');
    expect(JSON.stringify({ wrapped: cred })).toBe(
      '{"wrapped":"[Credential redacted]"}',
    );
  });

  it("redacts via util.inspect (used by console.log)", () => {
    const cred = new Credential({ token: "secret-token" });
    expect(inspect(cred)).toBe("[Credential redacted]");
    expect(inspect({ wrapped: cred })).toBe(
      "{ wrapped: [Credential redacted] }",
    );
  });

  it("does not expose internals as own enumerable properties", () => {
    const cred = new Credential({ token: "secret-token" });
    expect(Object.keys(cred)).toEqual([]);
    expect(Object.values(cred)).toEqual([]);
  });

  it("scopes raw access via .use(callback)", async () => {
    const cred = new Credential({ token: "secret-token" });
    const result = await cred.use(async (raw) => {
      return raw.token.toUpperCase();
    });
    expect(result).toBe("SECRET-TOKEN");
  });

  it("does not leak the secret string through the default error trace", () => {
    const cred = new Credential({ token: "secret-token" });
    try {
      const ctx = { user: "alice", cred };
      throw new Error(`failure: ${JSON.stringify(ctx)}`);
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-token");
      expect((err as Error).message).toContain("[Credential redacted]");
    }
  });

  // .use() must actively clear #raw in a finally block — GC timing is not
  // a security guarantee. After consumption: get() returns undefined, a
  // second use() throws. Holds for both happy path and callback-throw.
  it("actively consumes the credential after .use() resolves", async () => {
    const cred = new Credential({ token: "secret-token", api_key: "sk-1" });
    await cred.use(async (raw) => raw.token);

    expect(cred.get("token")).toBeUndefined();
    expect(cred.get("api_key")).toBeUndefined();
    await expect(
      cred.use(async (raw) => raw.token),
    ).rejects.toThrow(/already consumed/);
  });

  it("actively consumes the credential even when the .use() callback throws", async () => {
    const cred = new Credential({ token: "secret-token" });

    await expect(
      cred.use(async () => {
        throw new Error("simulated failure");
      }),
    ).rejects.toThrow(/simulated failure/);

    expect(cred.get("token")).toBeUndefined();
    await expect(
      cred.use(async (raw) => raw.token),
    ).rejects.toThrow(/already consumed/);
  });

  it("wipes string values inside #raw during clear (not just dropping the reference)", async () => {
    // We can't directly inspect #raw from outside, but we CAN observe the
    // wipe through a shared-reference trick: spy on what the callback's
    // copy looks like *after* the callback, by capturing the reference and
    // re-reading it post-clear. The wipe applied to `copy` inside use()
    // overwrites the captured object's values to empty strings.
    const cred = new Credential({ token: "secret-token", api_key: "sk-1" });
    let captured: Record<string, string> | null = null;

    await cred.use(async (raw) => {
      captured = raw;
      expect(raw.token).toBe("secret-token");
      return "ok";
    });

    expect(captured).not.toBeNull();
    expect((captured as unknown as Record<string, string>).token).toBe("");
    expect((captured as unknown as Record<string, string>).api_key).toBe("");
  });
});
