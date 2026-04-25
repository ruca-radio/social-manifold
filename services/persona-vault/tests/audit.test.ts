import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, readAudit } from "../src/audit.js";

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "audit-test-"));
  return join(dir, "audit.jsonl");
}

describe("audit log", () => {
  it("appends entries as JSON Lines", async () => {
    const path = await tmpFile();
    await appendAudit(path, {
      ts: "2026-04-25T12:00:00Z",
      persona_id: "p1",
      platform: "discord",
      requester_id: "child-discord",
      purpose: "post_to_community",
    });
    await appendAudit(path, {
      ts: "2026-04-25T12:00:01Z",
      persona_id: "p1",
      platform: "reddit",
      requester_id: "child-reddit",
      purpose: "reply_to_thread",
    });

    const raw = await readFile(path, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).platform).toBe("discord");
    expect(JSON.parse(lines[1]).platform).toBe("reddit");
  });

  it("reads back parsed entries", async () => {
    const path = await tmpFile();
    await appendAudit(path, {
      ts: "2026-04-25T12:00:00Z",
      persona_id: "p1",
      platform: "discord",
      requester_id: "x",
      purpose: "y",
    });
    const entries = await readAudit(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].requester_id).toBe("x");
  });

  it("returns empty array when audit file does not exist", async () => {
    const path = await tmpFile();
    const entries = await readAudit(path);
    expect(entries).toEqual([]);
  });
});
