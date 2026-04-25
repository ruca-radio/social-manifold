import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Decrypt a sops-encrypted YAML file via the `sops` CLI.
 *
 * LOAD-BEARING SECURITY PROPERTY — DO NOT EROSION-OPTIMIZE
 * ────────────────────────────────────────────────────────
 * The age private key is NEVER read into this Node process's memory.
 * We pass `SOPS_AGE_KEY_FILE` as an env var to the sops subprocess; sops
 * reads the file itself and the bytes are released when that short-lived
 * subprocess exits. The vault long-running process never holds them.
 *
 * Threat model — post-compromise key extraction:
 *   An attacker who gains code execution as the vault user (RCE in a
 *   dependency, e.g.) but cannot escalate to root has access to:
 *     1. the vault process's memory  (via /proc/<pid>/mem, gcore, ptrace)
 *     2. the audit log                (read-only mount in container)
 *   They MUST NOT have access to:
 *     3. the age key bytes
 *
 *   Property (3) holds because the key only ever exists on disk under
 *   `/etc/social-manifold/age.key` (mode 0400, root:social-manifold)
 *   bind-mounted read-only into the container, plus inside transient
 *   sops subprocess heap. Memory-dumping the long-running vault PID
 *   (`gcore`, `cat /proc/<vault-pid>/mem`, `dd if=/proc/<vault-pid>/maps`)
 *   yields zero key material.
 *
 *   Reading the key once at vault startup and piping it into sops via
 *   stdin / the `SOPS_AGE_KEY` env var would collapse this property:
 *   the bytes would live in the long-running process's heap for the
 *   life of the vault, indefinitely available to a memory dump. This
 *   is exactly the optimization a future "let's reduce per-call I/O"
 *   pass will be tempted by. Reject it.
 *
 * Decision context: CLAUDE.md §13 (resolved persona-vault decisions,
 * 2026-04-25) and §7.5 (co-located trust boundaries — vault is in
 * Zone B alongside child MCPs, so an RCE in any child is an RCE in
 * Zone B; the key's protection comes from staying out of Zone B
 * process memory, not from Zone B's perimeter).
 *
 * If you're considering changing this function: open an issue, get
 * sign-off, and if the change is approved, update CLAUDE.md §13 first.
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
