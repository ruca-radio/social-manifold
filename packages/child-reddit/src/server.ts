import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { unlink, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { VaultClient } from "@social-manifold/persona-vault/client";
import { createChildRedditMcpServer } from "./mcp-server.js";
import { liveRedditOAuth, liveRedditRest } from "./deps.js";
import type { RedditOAuthPort } from "./auth.js";
import type { RedditRestPort } from "./deps.js";

export interface ChildRedditServerConfig {
  socketPath: string;
  vault: VaultClient;
  oauth: RedditOAuthPort;
  rest: RedditRestPort;
}

export interface ChildRedditServerHandle {
  http: HttpServer;
  mcp: McpServer;
  close(): Promise<void>;
}

export async function createChildRedditServer(
  config: ChildRedditServerConfig,
): Promise<ChildRedditServerHandle> {
  const mcp = createChildRedditMcpServer({
    vault: config.vault,
    oauth: config.oauth,
    rest: config.rest,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);

  await mkdir(dirname(config.socketPath), { recursive: true });
  try {
    await unlink(config.socketPath);
  } catch {
    /* socket didn't exist */
  }
  const httpServer = createHttpServer((req, res) => {
    transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.socketPath, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  await chmod(config.socketPath, 0o660);

  return {
    http: httpServer,
    mcp,
    async close(): Promise<void> {
      await new Promise<void>((r) => httpServer.close(() => r()));
      await mcp.close();
    },
  };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const socketPath =
    process.env.CHILD_REDDIT_SOCKET_PATH ??
    "/run/social-manifold/children/reddit.sock";
  const vaultSocket =
    process.env.VAULT_SOCKET_PATH ?? "/run/social-manifold/vault.sock";

  const { existsSync } = await import("node:fs");
  if (!existsSync(dirname(socketPath))) {
    console.error(
      `child-reddit: socket directory ${dirname(socketPath)} does not exist. ` +
        "Run scripts/setup-runtime-dir.sh first (see ops/local/runbook.md).",
    );
    process.exit(1);
  }
  if (!existsSync(vaultSocket)) {
    console.error(
      `child-reddit: vault socket ${vaultSocket} does not exist. Is the vault running?`,
    );
    process.exit(1);
  }

  const vault = new VaultClient(vaultSocket);
  await createChildRedditServer({
    socketPath,
    vault,
    oauth: liveRedditOAuth,
    rest: liveRedditRest,
  });
  console.error(`child-reddit: MCP listening on ${socketPath}`);
}
