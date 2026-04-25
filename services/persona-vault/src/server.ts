import {
  createServer as createHttpServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { unlink, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listPersonas, loadIdentity, credentialsPath } from "./disk.js";
import { decryptSopsYaml } from "./sops.js";
import { appendAudit } from "./audit.js";
import type {
  CredentialRequest,
  CredentialResponse,
  ListPersonasResponse,
  ListPlatformsResponse,
  AuditEntry,
} from "./types.js";

export interface VaultConfig {
  personasRoot: string;
  auditPath: string;
  ageKeyPath: string;
  socketPath: string;
}

interface RouteCtx {
  config: VaultConfig;
  req: IncomingMessage;
  res: ServerResponse;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function handleListPersonas(ctx: RouteCtx): Promise<void> {
  const ids = await listPersonas(ctx.config.personasRoot);
  const body: ListPersonasResponse = { personas: ids };
  send(ctx.res, 200, body);
}

async function handleListPlatforms(
  ctx: RouteCtx,
  personaId: string,
): Promise<void> {
  try {
    const id = await loadIdentity(ctx.config.personasRoot, personaId);
    const platforms = Object.entries(id.platforms)
      .filter(([, v]) => v.enabled)
      .map(([k]) => k);
    const body: ListPlatformsResponse = { persona_id: personaId, platforms };
    send(ctx.res, 200, body);
  } catch {
    send(ctx.res, 404, { error: "persona not found" });
  }
}

async function handleGetCredential(
  ctx: RouteCtx,
  personaId: string,
  platform: string,
): Promise<void> {
  const body = (await readJsonBody(ctx.req)) as Partial<CredentialRequest> | null;
  if (
    !body ||
    typeof body.requester_id !== "string" ||
    typeof body.purpose !== "string" ||
    body.requester_id.length === 0 ||
    body.purpose.length === 0
  ) {
    send(ctx.res, 400, { error: "requester_id and purpose are required" });
    return;
  }

  let identity;
  try {
    identity = await loadIdentity(ctx.config.personasRoot, personaId);
  } catch {
    send(ctx.res, 404, { error: "persona not found" });
    return;
  }
  if (!identity.platforms[platform]?.enabled) {
    send(ctx.res, 404, { error: "platform not enabled for persona" });
    return;
  }

  let bundle: Record<string, unknown>;
  try {
    bundle = await decryptSopsYaml(
      credentialsPath(ctx.config.personasRoot, personaId),
      ctx.config.ageKeyPath,
    );
  } catch {
    send(ctx.res, 500, { error: "decryption failed" });
    return;
  }

  const platformCreds = bundle[platform];
  if (!platformCreds || typeof platformCreds !== "object") {
    send(ctx.res, 404, { error: "platform credentials not found" });
    return;
  }

  const auditEntry: AuditEntry = {
    ts: new Date().toISOString(),
    persona_id: personaId,
    platform,
    requester_id: body.requester_id,
    purpose: body.purpose,
  };
  await appendAudit(ctx.config.auditPath, auditEntry);

  const responseBody: CredentialResponse = {
    persona_id: personaId,
    platform,
    credential: platformCreds as Record<string, string>,
  };
  send(ctx.res, 200, responseBody);
}

function route(config: VaultConfig) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = req.url ?? "";
      const method = req.method ?? "GET";

      if (method === "GET" && url === "/v1/personas") {
        return handleListPersonas({ config, req, res });
      }

      const platformsMatch = url.match(/^\/v1\/personas\/([^/]+)\/platforms$/);
      if (method === "GET" && platformsMatch) {
        return handleListPlatforms({ config, req, res }, platformsMatch[1]);
      }

      const credMatch = url.match(
        /^\/v1\/personas\/([^/]+)\/credentials\/([^/]+)$/,
      );
      if (method === "POST" && credMatch) {
        return handleGetCredential(
          { config, req, res },
          credMatch[1],
          credMatch[2],
        );
      }

      send(res, 404, { error: "not found" });
    } catch {
      send(res, 500, { error: "internal" });
    }
  };
}

export async function createVaultServer(config: VaultConfig): Promise<Server> {
  await mkdir(dirname(config.socketPath), { recursive: true });
  try {
    await unlink(config.socketPath);
  } catch {
    /* socket didn't exist */
  }
  const server = createHttpServer(route(config));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await chmod(config.socketPath, 0o660);
  return server;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const socketPath =
    process.env.VAULT_SOCKET_PATH ?? "/run/social-manifold/vault.sock";
  const ageKeyPath =
    process.env.SOPS_AGE_KEY_FILE ?? "/etc/social-manifold/age.key";

  // Fail-fast: the runtime directory must exist with correct perms before
  // the vault starts. We do NOT auto-create it — see scripts/setup-runtime-dir.sh
  // and ops/local/runbook.md. Silent perms drift here would weaken the
  // filesystem-perms-as-auth model documented in CLAUDE.md §7.5.
  const { existsSync, statSync } = await import("node:fs");
  if (!existsSync(dirname(socketPath))) {
    console.error(
      `vault: socket directory ${dirname(socketPath)} does not exist. ` +
        "Run scripts/setup-runtime-dir.sh first (see ops/local/runbook.md).",
    );
    process.exit(1);
  }
  if (!existsSync(ageKeyPath)) {
    console.error(
      `vault: SOPS_AGE_KEY_FILE=${ageKeyPath} does not exist. ` +
        "Bootstrap a staging key with `pnpm persona:bootstrap-staging`, " +
        "or set AGE_KEY_PATH in your .env.",
    );
    process.exit(1);
  }
  const keyStat = statSync(ageKeyPath);
  const mode = keyStat.mode & 0o777;
  if (mode & 0o077) {
    console.error(
      `vault: age key file ${ageKeyPath} has loose permissions (mode ${mode.toString(8)}). ` +
        "Required: 0400 or 0440. Run `chmod 0400 " + ageKeyPath + "`.",
    );
    process.exit(1);
  }

  const config: VaultConfig = {
    personasRoot:
      process.env.VAULT_PERSONAS_ROOT ?? "/var/social-manifold/personas",
    auditPath:
      process.env.VAULT_AUDIT_PATH ??
      "/var/lib/social-manifold/vault-audit.jsonl",
    ageKeyPath,
    socketPath,
  };
  await createVaultServer(config);
  // server runs until process is killed
}
