import { describe, it, expect } from "vitest";
import { Credential } from "@social-manifold/persona-vault/client";
import { AccessTokenCache, type RedditOAuthPort } from "../src/auth.js";
import type { VaultClient } from "@social-manifold/persona-vault/client";

interface OAuthCallSpy {
  calls: Array<{ refresh_token: string; client_id: string }>;
}

function fakeOAuth(
  spy: OAuthCallSpy,
  opts: { token?: string; expiresIn?: number; throws?: Error } = {},
): RedditOAuthPort {
  return {
    async exchangeRefreshToken({ client_id, refresh_token }) {
      spy.calls.push({ refresh_token, client_id });
      if (opts.throws) throw opts.throws;
      return {
        access_token: opts.token ?? "access-1",
        expires_in: opts.expiresIn ?? 3600,
      };
    },
  };
}

function fakeVault(perCallCred: () => Credential): VaultClient {
  return {
    getCredential: async () => perCallCred(),
  } as unknown as VaultClient;
}

describe("AccessTokenCache", () => {
  it("fetches a fresh token on first lookup", async () => {
    const oauthSpy: OAuthCallSpy = { calls: [] };
    const cache = new AccessTokenCache(
      fakeVault(
        () =>
          new Credential({
            client_id: "ID",
            client_secret: "SECRET",
            refresh_token: "RT",
          }),
      ),
      fakeOAuth(oauthSpy),
      () => 1_000_000,
    );
    const t = await cache.tokenFor("p1");
    expect(t).toBe("access-1");
    expect(oauthSpy.calls).toHaveLength(1);
    expect(oauthSpy.calls[0].refresh_token).toBe("RT");
  });

  it("reuses the cached token when not near expiry", async () => {
    const oauthSpy: OAuthCallSpy = { calls: [] };
    let now = 1_000_000;
    const cache = new AccessTokenCache(
      fakeVault(
        () =>
          new Credential({
            client_id: "ID",
            client_secret: "SECRET",
            refresh_token: "RT",
          }),
      ),
      fakeOAuth(oauthSpy),
      () => now,
    );
    await cache.tokenFor("p1");
    now += 100_000;
    await cache.tokenFor("p1");
    expect(oauthSpy.calls).toHaveLength(1);
  });

  it("refreshes when within REFRESH_BUFFER of expiry", async () => {
    const oauthSpy: OAuthCallSpy = { calls: [] };
    let now = 1_000_000;
    const cache = new AccessTokenCache(
      fakeVault(
        () =>
          new Credential({
            client_id: "ID",
            client_secret: "SECRET",
            refresh_token: "RT",
          }),
      ),
      fakeOAuth(oauthSpy, { expiresIn: 100 }),
      () => now,
    );
    await cache.tokenFor("p1");
    now += 50_000;
    await cache.tokenFor("p1");
    expect(oauthSpy.calls).toHaveLength(2);
  });

  it("isolates tokens by persona", async () => {
    const oauthSpy: OAuthCallSpy = { calls: [] };
    let nextToken = 0;
    const cache = new AccessTokenCache(
      fakeVault(
        () =>
          new Credential({
            client_id: "ID",
            client_secret: "SECRET",
            refresh_token: `RT-${nextToken++}`,
          }),
      ),
      {
        async exchangeRefreshToken({ refresh_token }) {
          oauthSpy.calls.push({ refresh_token, client_id: "ID" });
          return {
            access_token: `T-${refresh_token}`,
            expires_in: 3600,
          };
        },
      },
      () => 1_000_000,
    );
    const a = await cache.tokenFor("p1");
    const b = await cache.tokenFor("p2");
    expect(a).not.toBe(b);
    expect(oauthSpy.calls).toHaveLength(2);
  });

  it("consumes the Credential during refresh (verifies .use() contract)", async () => {
    const oauthSpy: OAuthCallSpy = { calls: [] };
    let observedCred: Credential | null = null;
    const cred = new Credential({
      client_id: "ID",
      client_secret: "SECRET",
      refresh_token: "RT",
    });
    const cache = new AccessTokenCache(
      {
        getCredential: async () => {
          observedCred = cred;
          return cred;
        },
      } as unknown as VaultClient,
      fakeOAuth(oauthSpy),
      () => 1_000_000,
    );
    await cache.tokenFor("p1");
    expect(observedCred).not.toBeNull();
    expect((observedCred as Credential).get("refresh_token")).toBeUndefined();
  });

  it("throws when OAuth port returns an error", async () => {
    const oauthSpy: OAuthCallSpy = { calls: [] };
    const cache = new AccessTokenCache(
      fakeVault(
        () =>
          new Credential({
            client_id: "ID",
            client_secret: "SECRET",
            refresh_token: "RT",
          }),
      ),
      fakeOAuth(oauthSpy, { throws: new Error("invalid_grant") }),
      () => 1_000_000,
    );
    await expect(cache.tokenFor("p1")).rejects.toThrow(/invalid_grant/);
  });

  it("never holds the refresh_token visible via JSON.stringify on the cache", async () => {
    const oauthSpy: OAuthCallSpy = { calls: [] };
    const cache = new AccessTokenCache(
      fakeVault(
        () =>
          new Credential({
            client_id: "ID",
            client_secret: "SECRET",
            refresh_token: "REFRESH-SENTINEL-9X2",
          }),
      ),
      fakeOAuth(oauthSpy, { token: "ACCESS-OK" }),
      () => 1_000_000,
    );
    await cache.tokenFor("p1");
    expect(JSON.stringify(cache)).not.toContain("REFRESH-SENTINEL-9X2");
  });
});
