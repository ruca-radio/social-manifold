import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  chmod,
  readFile,
  writeFile,
  rename,
  mkdir,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

const PERSONA_ID = "_staging_alpha";
// Resolve repo root from this script's own location, not from process.cwd()
// (which is `scripts/` when invoked via `pnpm --filter @social-manifold/scripts`).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const PERSONA_DIR = join(REPO_ROOT, "personas", PERSONA_ID);
const KEY_PATH = join(PERSONA_DIR, ".age.key");
const CRED_PATH = join(PERSONA_DIR, "credentials.sops.yaml");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function generateAgeKey(): Promise<string> {
  const tmpKey = `${KEY_PATH}.tmp`;
  await exec("age-keygen", ["-o", tmpKey]);
  await chmod(tmpKey, 0o400);
  await rename(tmpKey, KEY_PATH);
  const contents = await readFile(KEY_PATH, "utf8");
  const m = contents.match(/# public key: (age1[a-z0-9]+)/i);
  if (!m) throw new Error("could not extract age recipient from generated key");
  return m[1];
}

async function readRecipient(): Promise<string> {
  const contents = await readFile(KEY_PATH, "utf8");
  const m = contents.match(/# public key: (age1[a-z0-9]+)/i);
  if (!m) throw new Error("existing key file missing recipient comment");
  return m[1];
}

async function encryptStagingCreds(recipient: string): Promise<void> {
  const fakeYaml = `discord:
  bot_token: STAGING-FAKE-DISCORD-BOT-TOKEN-DO-NOT-USE
  application_id: "000000000000000000"
`;
  await writeFile(CRED_PATH, fakeYaml, "utf8");
  await exec("sops", ["--encrypt", "--age", recipient, "--in-place", CRED_PATH]);
}

async function main(): Promise<void> {
  await mkdir(PERSONA_DIR, { recursive: true });

  let recipient: string;
  if (await exists(KEY_PATH)) {
    console.log(`age key already exists at ${KEY_PATH}, reusing`);
    recipient = await readRecipient();
  } else {
    console.log(`generating age key at ${KEY_PATH}`);
    recipient = await generateAgeKey();
  }
  console.log(`recipient: ${recipient}`);

  if (await exists(CRED_PATH)) {
    console.log(`credentials already exist at ${CRED_PATH}, leaving untouched`);
    return;
  }
  console.log(`encrypting staging credentials → ${CRED_PATH}`);
  await encryptStagingCreds(recipient);
  console.log(
    `done. Set AGE_KEY_PATH=${KEY_PATH} in your .env (or use the default).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
