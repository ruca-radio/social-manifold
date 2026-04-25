import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAudit,
  readAudit,
  __resetAuditWarningState,
} from "../src/audit.js";

const sampleEntry = {
  ts: "2026-04-25T12:00:00Z",
  persona_id: "p1",
  platform: "discord",
  requester_id: "x",
  purpose: "y",
};

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

describe("audit log size limits", () => {
  afterEach(() => {
    __resetAuditWarningState();
    vi.restoreAllMocks();
  });

  it("emits a one-shot stderr warning when the file size crosses the soft limit", async () => {
    const path = await tmpFile();
    // pre-fill the file just above the soft limit so the next append triggers
    await writeFile(path, "x".repeat(200), "utf8");

    const writes: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      });

    await appendAudit(path, sampleEntry, {
      softWarnBytes: 100,
      hardRefuseBytes: 10000,
    });
    // second append on the same path should NOT re-emit the warning
    await appendAudit(path, sampleEntry, {
      softWarnBytes: 100,
      hardRefuseBytes: 10000,
    });

    stderrSpy.mockRestore();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("soft limit");
    expect(writes[0]).toContain(path);
  });

  it("does not warn when the file size is below the soft limit", async () => {
    const path = await tmpFile();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await appendAudit(path, sampleEntry, {
      softWarnBytes: 1024 * 1024,
      hardRefuseBytes: 10 * 1024 * 1024,
    });

    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("throws when the file size has reached the hard refuse limit", async () => {
    const path = await tmpFile();
    await writeFile(path, "x".repeat(2048), "utf8");

    await expect(
      appendAudit(path, sampleEntry, {
        softWarnBytes: 100,
        hardRefuseBytes: 1024,
      }),
    ).rejects.toThrow(/exceeds hard limit/);
  });

  it("does not write a new entry when the hard limit is reached", async () => {
    const path = await tmpFile();
    await writeFile(path, "x".repeat(2048), "utf8");
    const before = (await readFile(path, "utf8")).length;

    await expect(
      appendAudit(path, sampleEntry, {
        softWarnBytes: 100,
        hardRefuseBytes: 1024,
      }),
    ).rejects.toThrow();

    const after = (await readFile(path, "utf8")).length;
    expect(after).toBe(before);
  });
});
