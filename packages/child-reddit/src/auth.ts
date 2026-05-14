import type { VaultClient } from "@social-manifold/persona-vault/client";

export interface RedditOAuthExchange {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

export interface RedditOAuthResponse {
  access_token: string;
  expires_in: number;
}

export interface RedditOAuthPort {
  exchangeRefreshToken(input: RedditOAuthExchange): Promise<RedditOAuthResponse>;
}

interface CacheEntry {
  access_token: string;
  expires_at_ms: number;
}

const REFRESH_BUFFER_MS = 60_000;

/**
 * Per-persona access-token cache for Reddit OAuth.
 *
 *   On tokenFor(persona_id):
 *     - cache hit AND now < expires_at_ms - 60s → return cached
 *     - else → vault.getCredential → .use(refresh_token → OAuth exchange)
 *               → cache result → return access_token
 *
 * The refresh_token never lives in this cache. Only the short-lived
 * access_token does. The Credential consumption happens inside .use(),
 * so the refresh_token is wiped from the wrapper after each refresh.
 *
 * Restart clears the cache (Plan 5 D3 + ops/local/runbook.md).
 */
export class AccessTokenCache {
  #cache = new Map<string, CacheEntry>();

  constructor(
    private readonly vault: VaultClient,
    private readonly oauth: RedditOAuthPort,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async tokenFor(personaId: string): Promise<string> {
    const cached = this.#cache.get(personaId);
    if (cached && this.now() < cached.expires_at_ms - REFRESH_BUFFER_MS) {
      return cached.access_token;
    }

    const cred = await this.vault.getCredential(personaId, "reddit", {
      requester_id: "child-reddit",
      purpose: `oauth_refresh:${personaId}`,
    });

    const result = await cred.use(async (raw) => {
      const { client_id, client_secret, refresh_token } = raw;
      if (!client_id || !client_secret || !refresh_token) {
        throw new Error(
          "child-reddit auth: credential bundle missing client_id, client_secret, or refresh_token",
        );
      }
      return this.oauth.exchangeRefreshToken({
        client_id,
        client_secret,
        refresh_token,
      });
    });

    const expires_at_ms = this.now() + result.expires_in * 1000;
    this.#cache.set(personaId, {
      access_token: result.access_token,
      expires_at_ms,
    });
    return result.access_token;
  }
}
