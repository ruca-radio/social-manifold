import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Decrypt a sops-encrypted YAML file via the `sops` CLI.
 *
 * LOAD-BEARING: the age private key is NEVER read into this Node process.
 * We pass `SOPS_AGE_KEY_FILE` as an env var to the sops subprocess; sops
 * reads the file itself and discards it when the subprocess exits.
 * Memory-dumping the vault PID will not yield the key bytes.
 *
 * Do NOT "optimize" this by reading the key file once at startup and
 * piping it into sops via stdin / `SOPS_AGE_KEY` env. That collapses the
 * trust boundary the architecture relies on (see CLAUDE.md §6).
 */
export async function decryptSopsYaml(
  filePath: string,
  ageKeyPath: string,
): Promise<Record<string, unknown>> {
  const { stdout } = await exec(
    "sops",
    ["--decrypt", "--input-type", "yaml", "--output-type", "json", filePath],
    {
      env: {
        ...process.env,
        SOPS_AGE_KEY_FILE: ageKeyPath,
      },
    },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}
