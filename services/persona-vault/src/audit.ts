import { appendFile, readFile, stat } from "node:fs/promises";
import type { AuditEntry } from "./types.js";

export interface AuditLimits {
  softWarnBytes: number;
  hardRefuseBytes: number;
}

const DEFAULT_LIMITS: AuditLimits = {
  softWarnBytes: 100 * 1024 * 1024, // 100 MB
  hardRefuseBytes: 1024 * 1024 * 1024, // 1 GB
};

const warnedPaths = new Set<string>();

/** Test-only: clear the per-path "already warned" memo. */
export function __resetAuditWarningState(): void {
  warnedPaths.clear();
}

/**
 * Append an audit entry to the JSON-Lines log at `path`.
 *
 * Size limits are enforced here pending log rotation (Plan 6 — telemetry):
 *   - softWarnBytes (default 100MB): emit a one-shot stderr warning per path.
 *   - hardRefuseBytes (default 1GB): throw. Callers should let this propagate
 *     and surface a 5xx — "no audit, no read" is the correct posture when the
 *     audit boundary itself is degraded. Operator must rotate before further
 *     credential reads.
 */
export async function appendAudit(
  path: string,
  entry: AuditEntry,
  limits: AuditLimits = DEFAULT_LIMITS,
): Promise<void> {
  let size = 0;
  try {
    const s = await stat(path);
    size = s.size;
  } catch {
    // file does not exist yet — size is 0
  }
  if (size >= limits.hardRefuseBytes) {
    throw new Error(
      `audit log at ${path} is ${size} bytes, exceeds hard limit ` +
        `${limits.hardRefuseBytes} bytes — rotate or truncate before further credential reads`,
    );
  }
  if (size >= limits.softWarnBytes && !warnedPaths.has(path)) {
    warnedPaths.add(path);
    process.stderr.write(
      `vault: audit log at ${path} is ${(size / 1024 / 1024).toFixed(1)} MB ` +
        `(soft limit ${(limits.softWarnBytes / 1024 / 1024).toFixed(0)} MB) — ` +
        `rotation lands in Plan 6\n`,
    );
  }
  await appendFile(path, JSON.stringify(entry) + "\n", { encoding: "utf8" });
}

export async function readAudit(path: string): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}
