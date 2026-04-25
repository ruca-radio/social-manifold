import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { Server } from "node:http";
import { createVaultServer } from "../src/server.js";
import { Credential } from "../src/client/credential.js";

const exec = promisify(execFile);

async function generateAgeIdentity(): Promise<{
  keyPath: string;
  recipient: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "vault-age-"));
  const keyPath = join(dir, "test.age.key");
  await exec("age-keygen", ["-o", keyPath]);
  await chmod(keyPath, 0o400);
  const contents = await readFile(keyPath, "utf8");
  const m = contents.match(/# public key: (age1[a-z0-9]+)/i);
  if (!m) throw new Error("no recipient");
  return { keyPath, recipient: m[1] };
}

interface TestRig {
  socket: string;
  personasRoot: string;
  auditPath: string;
  ageKey: string;
  server: Server;
  // unique sentinel values placed in test creds — used to verify they
  // never appear where they shouldn't (other-platform responses, audit log).
  discordSecret: string;
  redditSecret: string;
}

async function setupRig(): Promise<TestRig> {
  const tmp = await mkdtemp(join(tmpdir(), "vault-srv-"));
  const personasRoot = join(tmp, "personas");
  await mkdir(personasRoot, { recursive: true });

  const personaDir = join(personasRoot, "persona_test");
  await mkdir(personaDir, { recursive: true });
  await writeFile(
    join(personaDir, "identity.yaml"),
    `id: persona_test
display_name: "Test"
type: branded_bot
timezone: UTC
locale: en-US
working_hours: "00:00-23:59"
posting_cadence_minutes: [1, 3]
proxy_pool: none
disclosed_automation: true
platforms:
  discord:
    enabled: true
    credential_ref: discord_token
  reddit:
    enabled: true
    credential_ref: reddit_oauth
`,
    "utf8",
  );

  const { keyPath, recipient } = await generateAgeIdentity();
  const discordSecret = "DISCORD-SENTINEL-VALUE-AB99";
  const redditSecret = "REDDIT-SENTINEL-VALUE-CD77";
  const credYaml = `discord:
  bot_token: ${discordSecret}
  application_id: "111"
reddit:
  client_id: reddit-client-id
  client_secret: ${redditSecret}
`;
  const credPath = join(personaDir, "credentials.sops.yaml");
  await writeFile(credPath, credYaml, "utf8");
  await exec("sops", ["--encrypt", "--age", recipient, "--in-place", credPath]);

  const auditPath = join(tmp, "audit.jsonl");
  const socket = join(tmp, "vault.sock");
  const server = await createVaultServer({
    personasRoot,
    auditPath,
    ageKeyPath: keyPath,
    socketPath: socket,
  });

  return {
    socket,
    personasRoot,
    auditPath,
    ageKey: keyPath,
    server,
    discordSecret,
    redditSecret,
  };
}

function uds(
  socketPath: string,
  method: string,
  path: string,
  body?: object,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: body ? { "content-type": "application/json" } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: any = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("vault HTTP-over-UDS server", () => {
  let rig: TestRig;

  beforeAll(async () => {
    rig = await setupRig();
  });

  afterAll(async () => {
    await new Promise<void>((r) => rig.server.close(() => r()));
  });

  it("GET /v1/personas lists persona IDs", async () => {
    const res = await uds(rig.socket, "GET", "/v1/personas");
    expect(res.status).toBe(200);
    expect(res.body.personas).toEqual(["persona_test"]);
  });

  it("GET /v1/personas/:id/platforms lists enabled platforms", async () => {
    const res = await uds(
      rig.socket,
      "GET",
      "/v1/personas/persona_test/platforms",
    );
    expect(res.status).toBe(200);
    expect(res.body.persona_id).toBe("persona_test");
    expect(res.body.platforms.sort()).toEqual(["discord", "reddit"]);
  });

  // SECURITY-CRITICAL: per-platform fetch must return ONLY that platform's
  // creds. We use unique sentinel values for each platform so a regression
  // (e.g., returning the entire decrypted bundle) would fail this assertion
  // unambiguously rather than passing because the assertion was too narrow.
  it("POST credentials returns ONLY the requested platform's creds (sentinel check)", async () => {
    const res = await uds(
      rig.socket,
      "POST",
      "/v1/personas/persona_test/credentials/discord",
      { requester_id: "test-runner", purpose: "vault server test" },
    );
    expect(res.status).toBe(200);
    expect(res.body.persona_id).toBe("persona_test");
    expect(res.body.platform).toBe("discord");
    expect(res.body.credential.bot_token).toBe(rig.discordSecret);
    expect(res.body.credential.application_id).toBe("111");

    // The reddit sentinel MUST NOT appear anywhere in the discord response.
    // The string match is over the entire serialized response — covers the
    // failure mode "regression returned full bundle in response.credential"
    // AND "regression leaked it into a different field" simultaneously.
    const wholeResponse = JSON.stringify(res.body);
    expect(wholeResponse).not.toContain(rig.redditSecret);
    expect(wholeResponse).not.toContain("client_id");
    expect(wholeResponse).not.toContain("client_secret");
    // also: the credential field has exactly the keys we expect, no others
    expect(Object.keys(res.body.credential).sort()).toEqual([
      "application_id",
      "bot_token",
    ]);
  });

  it("appends an audit entry on successful credential read; secrets never enter audit", async () => {
    await uds(
      rig.socket,
      "POST",
      "/v1/personas/persona_test/credentials/reddit",
      { requester_id: "audit-test", purpose: "smoke" },
    );
    const audit = await readFile(rig.auditPath, "utf8");
    expect(audit).toContain('"requester_id":"audit-test"');
    expect(audit).toContain('"platform":"reddit"');
    // CRITICAL: the actual secret values never reach the audit log
    expect(audit).not.toContain(rig.discordSecret);
    expect(audit).not.toContain(rig.redditSecret);
  });

  it("returns 404 for an unknown persona", async () => {
    const res = await uds(
      rig.socket,
      "POST",
      "/v1/personas/nope/credentials/discord",
      { requester_id: "x", purpose: "y" },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown platform on a known persona", async () => {
    const res = await uds(
      rig.socket,
      "POST",
      "/v1/personas/persona_test/credentials/twitter",
      { requester_id: "x", purpose: "y" },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when requester_id or purpose is missing", async () => {
    const res = await uds(
      rig.socket,
      "POST",
      "/v1/personas/persona_test/credentials/discord",
      { requester_id: "" },
    );
    expect(res.status).toBe(400);
  });

  // No bulk-dump endpoint exists. This test enumerates the endpoints that
  // DO exist that COULD be misused for enumeration, and asserts they expose
  // metadata only (IDs, platform names) — never values.
  it("has NO endpoint that returns multiple platforms' credentials", async () => {
    const personasRes = await uds(rig.socket, "GET", "/v1/personas");
    expect(JSON.stringify(personasRes.body)).not.toContain(rig.discordSecret);
    expect(JSON.stringify(personasRes.body)).not.toContain(rig.redditSecret);

    const platformsRes = await uds(
      rig.socket,
      "GET",
      "/v1/personas/persona_test/platforms",
    );
    expect(JSON.stringify(platformsRes.body)).not.toContain(rig.discordSecret);
    expect(JSON.stringify(platformsRes.body)).not.toContain(rig.redditSecret);
    // /platforms exposes platform NAMES only, never their values:
    expect(JSON.stringify(platformsRes.body)).not.toContain("bot_token");
    expect(JSON.stringify(platformsRes.body)).not.toContain("client_secret");

    // Probing for a "give me everything" endpoint variant — these MUST 404.
    for (const path of [
      "/v1/personas/persona_test/credentials",
      "/v1/personas/persona_test",
      "/v1/credentials",
      "/v1/dump",
    ]) {
      const r = await uds(rig.socket, "GET", path);
      expect(r.status, `unexpected non-404 for ${path}`).toBe(404);
    }
  });

  it("client wraps the response credential into a redacting Credential", async () => {
    const res = await uds(
      rig.socket,
      "POST",
      "/v1/personas/persona_test/credentials/discord",
      { requester_id: "wrap-test", purpose: "demo" },
    );
    const cred = new Credential(res.body.credential);
    expect(cred.get("bot_token")).toBe(rig.discordSecret);
    expect(JSON.stringify(cred)).toBe('"[Credential redacted]"');
  });
});
