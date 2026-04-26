export interface CadenceLoader {
  cadenceMinutes(personaId: string): Promise<[number, number]>;
}

export interface CheckResult {
  allowed: boolean;
  retry_after_seconds?: number;
}

interface State {
  last_action_ts_ms?: number;
  backoff_until_ms?: number;
}

/**
 * Two-layer in-process rate-limit accountant.
 *
 *   Layer 1: per-persona behavioral floor — `posting_cadence_minutes[0]` from
 *            identity.yaml. The persona must wait at least that many minutes
 *            between actions on a given platform.
 *   Layer 2: platform-observed backoff — when a child reports
 *            `VerbResult.platform_rate_limit`, we record `backoff_until = now
 *            + retry_after`. Future checkAndReserve calls are denied until
 *            both that time AND the cadence floor are past.
 *
 * State is held in memory keyed by `${persona_id}:${platform}`. Restart
 * clears state — see Plan 4 D5 + ops/local/runbook.md.
 *
 * Public surface is intentionally narrow so this can be extracted to a
 * separate service later (Plan 4 D3) without source changes at the call
 * site beyond the import.
 */
export class RateLimitAccountant {
  #state = new Map<string, State>();

  constructor(private readonly identity: CadenceLoader) {}

  async checkAndReserve(
    personaId: string,
    platform: string,
    nowMs: number,
  ): Promise<CheckResult> {
    const key = this.#k(personaId, platform);
    const s = this.#state.get(key) ?? {};
    const cadence = await this.identity.cadenceMinutes(personaId);
    const floorMs = cadence[0] * 60_000;

    const cadenceReadyAt =
      s.last_action_ts_ms !== undefined ? s.last_action_ts_ms + floorMs : 0;
    const backoffReadyAt = s.backoff_until_ms ?? 0;
    const readyAt = Math.max(cadenceReadyAt, backoffReadyAt);

    if (nowMs >= readyAt) {
      this.#state.set(key, { ...s, last_action_ts_ms: nowMs });
      return { allowed: true };
    }
    return {
      allowed: false,
      retry_after_seconds: Math.ceil((readyAt - nowMs) / 1000),
    };
  }

  recordPlatformBackoff(
    personaId: string,
    platform: string,
    retryAfterSeconds: number,
    nowMs: number,
  ): void {
    const key = this.#k(personaId, platform);
    const s = this.#state.get(key) ?? {};
    this.#state.set(key, {
      ...s,
      backoff_until_ms: nowMs + retryAfterSeconds * 1000,
    });
  }

  recordSuccessfulCall(
    personaId: string,
    platform: string,
    nowMs: number,
  ): void {
    const key = this.#k(personaId, platform);
    const s = this.#state.get(key) ?? {};
    if (s.last_action_ts_ms === undefined || nowMs > s.last_action_ts_ms) {
      this.#state.set(key, { ...s, last_action_ts_ms: nowMs });
    }
  }

  #k(personaId: string, platform: string): string {
    return `${personaId}:${platform}`;
  }
}
