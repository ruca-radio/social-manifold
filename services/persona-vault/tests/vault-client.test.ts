import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createVaultServer } from "../src/server.js";
import { VaultClient } from "../src/client/vault-client.js";
import { Credential } from "../src/client/credential.js";

const exec = promisify(execFile);

interface Rig {
  socket: string;
  server: Server;
  secret: string;
}

async function setup(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), "vc-"));
  const personasRoot = join(tmp, "personas");
  await mkdir(join(personasRoot, "p1"), { recursive: true });
  await writeFile(
    join(personasRoot, "p1", "identity.yaml"),
    `id: p1
display_name: "p1"
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
`,
    "utf8",
  );
  const ageDir = await mkdtemp(join(tmpdir(), "vc-age-"));
  const ageKey = join(ageDir, "k");
  await exec("age-keygen", ["-o", ageKey]);
  await chmod(ageKey, 0o400);
  const recipient = (await readFile(ageKey, "utf8")).match(
    /# public key: (age1[a-z0-9]+)/i,
  )![1];

  const SECRET = "VC-SENTINEL-MN3K";
  const credPath = join(personasRoot, "p1", "credentials.sops.yaml");
  await writeFile(
    credPath,
    `discord:\n  bot_token: ${SECRET}\n`,
    "utf8",
  );
  await exec("sops", ["--encrypt", "--age", recipient, "--in-place", credPath]);

  const socket = join(tmp, "v.sock");
  const server = await createVaultServer({
    personasRoot,
    auditPath: join(tmp, "audit.jsonl"),
    ageKeyPath: ageKey,
    socketPath: socket,
  });
  return { socket, server, secret: SECRET };
}

describe("VaultClient", () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await setup();
  });
  afterAll(async () => {
    await new Promise<void>((r) => rig.server.close(() => r()));
  });

  it("listPersonas() returns persona IDs", async () => {
    const c = new VaultClient(rig.socket);
    expect(await c.listPersonas()).toEqual(["p1"]);
  });

  it("listPlatforms() returns enabled platform names only", async () => {
    const c = new VaultClient(rig.socket);
    expect(await c.listPlatforms("p1")).toEqual(["discord"]);
  });

  it("getCredential() returns a Credential wrapping the platform creds", async () => {
    const c = new VaultClient(rig.socket);
    const cred = await c.getCredential("p1", "discord", {
      requester_id: "test",
      purpose: "vault-client-test",
    });
    expect(cred).toBeInstanceOf(Credential);
    expect(cred.get("bot_token")).toBe(rig.secret);
  });

  it("getCredential() returns a redacting Credential (toJSON guard)", async () => {
    const c = new VaultClient(rig.socket);
    const cred = await c.getCredential("p1", "discord", {
      requester_id: "t",
      purpose: "p",
    });
    expect(JSON.stringify(cred)).toBe('"[Credential redacted]"');
  });

  it("getCredential() throws on unknown persona", async () => {
    const c = new VaultClient(rig.socket);
    await expect(
      c.getCredential("ghost", "discord", { requester_id: "t", purpose: "p" }),
    ).rejects.toThrow();
  });

  it("getCredential() throws when requester_id is empty", async () => {
    const c = new VaultClient(rig.socket);
    await expect(
      c.getCredential("p1", "discord", { requester_id: "", purpose: "x" }),
    ).rejects.toThrow();
  });
});
