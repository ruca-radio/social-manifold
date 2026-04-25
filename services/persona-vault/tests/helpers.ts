import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeTmpPersonaRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vault-test-"));
}

export async function writePersona(
  root: string,
  id: string,
  identityYaml: string,
  encryptedYaml?: string,
): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "identity.yaml"), identityYaml, "utf8");
  if (encryptedYaml !== undefined) {
    await writeFile(join(dir, "credentials.sops.yaml"), encryptedYaml, "utf8");
  }
  return dir;
}

export const SAMPLE_IDENTITY = `id: persona_test
display_name: "Test Persona"
type: branded_bot
timezone: UTC
locale: en-US
working_hours: "00:00-23:59"
posting_cadence_minutes: [1, 3]
proxy_pool: none_test_only
disclosed_automation: true
platforms:
  discord:
    enabled: true
    credential_ref: discord_token
  reddit:
    enabled: false
`;
