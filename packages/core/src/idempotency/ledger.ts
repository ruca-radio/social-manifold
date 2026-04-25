import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import type { VerbResult } from "@social-manifold/contracts";
import { SCHEMA } from "./schema.js";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LedgerOptions {
  ttlMs?: number;
}

interface LookupRow {
  response_blob: string;
  created_at_ms: number;
}

interface CountRow {
  c: number;
}

/**
 * Idempotency ledger backed by SQLite (better-sqlite3, sync API).
 * TTL is enforced lazily on lookup — see CLAUDE.md §9 and Plan 4 D2.
 */
export class IdempotencyLedger {
  #db: DB;
  #ttlMs: number;
  #stmtLookup;
  #stmtRecord;
  #stmtDelete;
  #stmtCount;

  constructor(filePath: string, opts: LedgerOptions = {}) {
    this.#db = new Database(filePath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.exec(SCHEMA);
    this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

    this.#stmtLookup = this.#db.prepare(
      "SELECT response_blob, created_at_ms FROM idempotency WHERE idempotency_key = ?",
    );
    this.#stmtRecord = this.#db.prepare(
      `INSERT INTO idempotency (idempotency_key, persona_id, verb, response_blob, created_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         persona_id = excluded.persona_id,
         verb = excluded.verb,
         response_blob = excluded.response_blob,
         created_at_ms = excluded.created_at_ms`,
    );
    this.#stmtDelete = this.#db.prepare(
      "DELETE FROM idempotency WHERE idempotency_key = ?",
    );
    this.#stmtCount = this.#db.prepare("SELECT COUNT(*) AS c FROM idempotency");
  }

  lookup(key: string): VerbResult | null {
    const row = this.#stmtLookup.get(key) as LookupRow | undefined;
    if (!row) return null;
    const ageMs = Date.now() - row.created_at_ms;
    if (ageMs > this.#ttlMs) {
      this.#stmtDelete.run(key);
      return null;
    }
    const original = JSON.parse(row.response_blob) as VerbResult;
    const at = new Date(row.created_at_ms).toISOString();
    return {
      ...original,
      status: "deduped",
      warnings: [`deduped from ${at}`, ...(original.warnings ?? [])],
    };
  }

  record(
    key: string,
    personaId: string,
    verb: string,
    result: VerbResult,
  ): void {
    this.#stmtRecord.run(
      key,
      personaId,
      verb,
      JSON.stringify(result),
      Date.now(),
    );
  }

  size(): number {
    const row = this.#stmtCount.get() as CountRow | undefined;
    return row?.c ?? 0;
  }

  close(): void {
    this.#db.close();
  }
}
