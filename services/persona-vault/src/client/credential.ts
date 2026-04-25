/**
 * Credential — client-side wrapper for credential bundles returned by the vault.
 *
 * Redaction-by-default:
 *   - toJSON / toString / util.inspect.custom all return "[Credential redacted]"
 *   - the raw bundle is held in a private class field (#raw); not enumerable,
 *     not visible to JSON.stringify, not visible to console.log.
 *   - access is scoped via .get(key) for single values or .use(cb) for closures.
 *
 * The .use() pattern is preferred for any operation that touches more than one
 * field (e.g., signing a request, building an OAuth header) because it makes
 * the credential's lifetime visible at the call site instead of relying on
 * every consumer to remember not to log .get() results. The callback receives
 * a shallow copy of the raw bundle.
 */
const REDACTED = "[Credential redacted]";
const inspectSym = Symbol.for("nodejs.util.inspect.custom");

export class Credential {
  readonly #raw: Record<string, string>;

  constructor(raw: Record<string, string>) {
    this.#raw = { ...raw };
  }

  get(key: string): string | undefined {
    return this.#raw[key];
  }

  async use<T>(fn: (raw: Record<string, string>) => Promise<T> | T): Promise<T> {
    return fn({ ...this.#raw });
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspectSym](): string {
    return REDACTED;
  }
}
