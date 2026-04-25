import {
  createServer as createHttpServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import { VaultClient } from "@social-manifold/persona-vault/client";
import type {
  DiscordPostMessageRequest,
  DiscordPostMessageResponse,
} from "@social-manifold/contracts";
import { liveDiscordRest, type DiscordRestPort } from "./deps.js";
import { postMessage } from "./adapter.js";

export interface ChildDiscordConfig {
  port: number;
  vault: VaultClient;
  rest: DiscordRestPort;
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

async function handlePostMessage(
  req: IncomingMessage,
  res: ServerResponse,
  vault: VaultClient,
  rest: DiscordRestPort,
): Promise<void> {
  const body = (await readJsonBody(req)) as Partial<DiscordPostMessageRequest> | null;
  if (
    !body ||
    typeof body.persona_id !== "string" ||
    typeof body.channel_id !== "string" ||
    typeof body.content !== "string" ||
    typeof body.idempotency_key !== "string"
  ) {
    send(res, 400, { error: "missing required fields" });
    return;
  }

  let cred;
  try {
    cred = await vault.getCredential(body.persona_id, "discord", {
      requester_id: "child-discord",
      purpose: `post-message:${body.idempotency_key}`,
    });
  } catch (err) {
    send(res, 404, {
      error: "credential not available",
      detail: (err as Error).message,
    });
    return;
  }

  try {
    const result: DiscordPostMessageResponse = await postMessage(cred, rest, {
      channel_id: body.channel_id,
      content: body.content,
    });
    send(res, 200, result);
  } catch (err) {
    send(res, 502, {
      error: "discord call failed",
      detail: (err as Error).message,
    });
  }
}

function route(vault: VaultClient, rest: DiscordRestPort) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method === "POST" && req.url === "/v1/post-message") {
        return handlePostMessage(req, res, vault, rest);
      }
      send(res, 404, { error: "not found" });
    } catch {
      send(res, 500, { error: "internal" });
    }
  };
}

export async function createChildDiscordServer(
  config: ChildDiscordConfig,
): Promise<Server> {
  const server = createHttpServer(route(config.vault, config.rest));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.CHILD_DISCORD_PORT ?? "7811");
  const vaultSocket =
    process.env.VAULT_SOCKET_PATH ?? "/run/social-manifold/vault.sock";

  const { existsSync } = await import("node:fs");
  if (!existsSync(vaultSocket)) {
    console.error(
      `child-discord: vault socket ${vaultSocket} does not exist. Is the vault running?`,
    );
    process.exit(1);
  }
  const vault = new VaultClient(vaultSocket);
  await createChildDiscordServer({ port, vault, rest: liveDiscordRest });
  console.error(`child-discord: listening on :${port}`);
}
