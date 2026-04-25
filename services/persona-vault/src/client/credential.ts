/**
 * Credential — client-side wrapper for credential bundles returned by the vault.
 *
 * Two access modes:
 *   - .get(key)        : single-value reads. The credential remains usable.
 *   - .use(callback)   : scoped compound access. After the callback resolves
 *                        OR throws, the credential is ACTIVELY CONSUMED:
 *                        every value is overwritten with empty strings and
 *                        the internal reference is set to null. Subsequent
 *                        .get() returns undefined; subsequent .use() throws.
 *
 * Why active clear, not GC: V8 cannot guarantee when an unreferenced object's
 * memory is reclaimed, and string interning means even a "freed" string may
 * persist elsewhere in the heap. The active wipe is best-effort — V8 may
 * still hold copies — but it shortens the post-use window where a memory
 * dump would yield the bytes. GC timing is not a security guarantee.
 *
 * Redaction-by-default:
 *   - toJSON / toString / util.inspect.custom all return "[Credential redacted]"
 *   - the raw bundle is held in a private class field (#raw); not enumerable,
 *     not visible to JSON.stringify, not visible to console.log.
 *
 * The .use() pattern is preferred for any operation that touches more than
 * one field (e.g., signing a request, building an OAuth header) because it
 * makes the credential's lifetime visible at the call site instead of
 * relying on every consumer to remember not to log .get() results.
 */
const REDACTED = "[Credential redacted]";
const inspectSym = Symbol.for("nodejs.util.inspect.custom");

export class Credential {
  #raw: Record<string, string> | null;

  constructor(raw: Record<string, string>) {
    this.#raw = { ...raw };
  }

  get(key: string): string | undefined {
    if (this.#raw === null) return undefined;
    return this.#raw[key];
  }

  /**
   * Scope raw access to a callback. After the callback resolves or rejects,
   * this credential is actively cleared and cannot be used again.
   * The callback receives a shallow copy that is also wiped on completion.
   */
  async use<T>(fn: (raw: Record<string, string>) => Promise<T> | T): Promise<T> {
    if (this.#raw === null) {
      throw new Error("Credential already consumed");
    }
    const copy: Record<string, string> = { ...this.#raw };
    try {
      return await fn(copy);
    } finally {
      // Active wipe — best-effort. V8 may still hold string copies, but
      // removing every reference we control shortens the exposure window.
      // GC timing is not a security guarantee — this clear must be
      // synchronous and unconditional. (See class header docs.)
      for (const k of Object.keys(copy)) {
        copy[k] = "";
      }
      if (this.#raw !== null) {
        for (const k of Object.keys(this.#raw)) {
          this.#raw[k] = "";
        }
        this.#raw = null;
      }
    }
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
