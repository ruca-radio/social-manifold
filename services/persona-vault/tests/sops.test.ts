import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptSopsYaml } from "../src/sops.js";

const exec = promisify(execFile);

interface TestVault {
  ageKeyPath: string;
  ageRecipient: string;
}

async function generateAgeIdentity(): Promise<TestVault> {
  const dir = await mkdtemp(join(tmpdir(), "vault-age-"));
  const keyPath = join(dir, "test.age.key");
  // age-keygen writes the public key to stderr; we read it from the file's
  // `# public key:` comment line, which is the canonical place.
  await exec("age-keygen", ["-o", keyPath]);
  await chmod(keyPath, 0o400);
  const contents = await readFile(keyPath, "utf8");
  const recipientMatch = contents.match(/# public key: (age1[a-z0-9]+)/i);
  if (!recipientMatch) {
    throw new Error(
      `could not extract age recipient from generated key file ${keyPath}`,
    );
  }
  return { ageKeyPath: keyPath, ageRecipient: recipientMatch[1] };
}

async function encryptWithSops(
  plaintextYaml: string,
  recipient: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vault-enc-"));
  const inPath = join(dir, "creds.yaml");
  await writeFile(inPath, plaintextYaml, "utf8");
  await exec("sops", [
    "--encrypt",
    "--age",
    recipient,
    "--in-place",
    inPath,
  ]);
  return inPath;
}

describe("sops decryption", () => {
  let vault: TestVault;

  beforeAll(async () => {
    vault = await generateAgeIdentity();
  });

  it("decrypts a sops-encrypted yaml file given the age key", async () => {
    const plaintext = `discord:
  bot_token: discord-bot-token-xyz
  application_id: "111111111"
reddit:
  client_id: reddit-client-id
  client_secret: reddit-client-secret
`;
    const encryptedPath = await encryptWithSops(plaintext, vault.ageRecipient);

    const decrypted = await decryptSopsYaml(encryptedPath, vault.ageKeyPath);
    expect(decrypted.discord).toBeDefined();
    expect((decrypted.discord as Record<string, string>).bot_token).toBe(
      "discord-bot-token-xyz",
    );
    expect((decrypted.reddit as Record<string, string>).client_secret).toBe(
      "reddit-client-secret",
    );
  });

  // NEGATIVE TEST — strong form:
  // 1. plaintext value is uniquely identifiable ("NEVER-LEAK-THIS-VALUE")
  // 2. file on disk after encryption does NOT contain that value
  // 3. file on disk has sops envelope markers (sops:, ENC[)
  // 4. AND decryption with the correct key DOES yield the value (proves we
  //    actually encrypted the right plaintext, not silently wrote a stub)
  // The 4-way check is the guard against a false positive where the
  // assertions pass because the plaintext was never written.
  it("NEGATIVE: encrypted file on disk contains ciphertext, not plaintext", async () => {
    const SECRET = "NEVER-LEAK-THIS-VALUE-ZK7Q";
    const plaintext = `discord:\n  bot_token: ${SECRET}\n`;
    const encryptedPath = await encryptWithSops(plaintext, vault.ageRecipient);

    const onDisk = await readFile(encryptedPath, "utf8");
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).toContain("sops:");
    expect(onDisk).toMatch(/ENC\[/);

    const roundtrip = await decryptSopsYaml(encryptedPath, vault.ageKeyPath);
    expect((roundtrip.discord as Record<string, string>).bot_token).toBe(
      SECRET,
    );
  });

  // NEGATIVE TEST — strong form:
  // The encrypted file is known-valid (we verify a successful decrypt with
  // the correct key in the same test). The wrong-path attempt must fail
  // BECAUSE OF THE MISSING KEY, not because of any other reason.
  it("NEGATIVE: decryption fails when the age key file does not exist", async () => {
    const SECRET = "another-unique-secret-PQ3X";
    const plaintext = `discord:\n  bot_token: ${SECRET}\n`;
    const encryptedPath = await encryptWithSops(plaintext, vault.ageRecipient);

    // sanity: file IS valid sops + correct key works
    const ok = await decryptSopsYaml(encryptedPath, vault.ageKeyPath);
    expect((ok.discord as Record<string, string>).bot_token).toBe(SECRET);

    // bad path → must reject
    const nonexistent = join(tmpdir(), "definitely-no-key-here-9XQ.key");
    let caughtError: Error | undefined;
    try {
      await decryptSopsYaml(encryptedPath, nonexistent);
    } catch (err) {
      caughtError = err as Error;
    }
    expect(caughtError).toBeDefined();
    // sops surfaces this as a non-zero exit; the error message must reference
    // either the missing key or a decryption failure (not, say, a YAML parse
    // error which would indicate we misidentified the failure mode).
    const msg = (caughtError?.message ?? "") + (caughtError as { stderr?: string })?.stderr ?? "";
    expect(msg.toLowerCase()).toMatch(/key|decrypt|age|no such file|not found/);
  });

  // NEGATIVE TEST — strongest form:
  // Two independent age identities. File encrypted to recipient A, attempt
  // decrypt with valid key B. Failure is unambiguously "wrong recipient",
  // not "bad file" or "missing file". Also asserts no plaintext leaks
  // through stdout/stderr of the failing call.
  it("NEGATIVE: decryption fails with a wrong (but valid) age key, and no plaintext leaks", async () => {
    const SECRET = "third-distinct-secret-LM2W";
    const plaintext = `discord:\n  bot_token: ${SECRET}\n`;
    const encryptedPath = await encryptWithSops(plaintext, vault.ageRecipient);

    const otherVault = await generateAgeIdentity();
    expect(otherVault.ageRecipient).not.toBe(vault.ageRecipient);

    let caughtError: (Error & { stdout?: string; stderr?: string }) | undefined;
    try {
      await decryptSopsYaml(encryptedPath, otherVault.ageKeyPath);
    } catch (err) {
      caughtError = err as Error & { stdout?: string; stderr?: string };
    }
    expect(caughtError).toBeDefined();
    // the secret must not appear in any output stream of the failed decrypt
    expect(caughtError?.stdout ?? "").not.toContain(SECRET);
    expect(caughtError?.stderr ?? "").not.toContain(SECRET);
    expect(caughtError?.message ?? "").not.toContain(SECRET);
  });
});
