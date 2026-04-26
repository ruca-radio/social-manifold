export const SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency (
  idempotency_key TEXT PRIMARY KEY,
  persona_id      TEXT NOT NULL,
  verb            TEXT NOT NULL,
  response_blob   TEXT NOT NULL,
  created_at_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created_at
  ON idempotency(created_at_ms);
`;
