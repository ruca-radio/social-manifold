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
});
