import { appendFile, readFile } from "node:fs/promises";
import type { AuditEntry } from "./types.js";

export async function appendAudit(
  path: string,
  entry: AuditEntry,
): Promise<void> {
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
