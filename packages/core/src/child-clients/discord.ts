import { request } from "node:http";
import type {
  DiscordPostMessageRequest,
  DiscordPostMessageResponse,
} from "@social-manifold/contracts";

export interface DiscordChildClientConfig {
  host: string;
  port: number;
}

interface RawResponse {
  status: number;
  body: unknown;
}

function tcp(
  cfg: DiscordChildClientConfig,
  method: string,
  path: string,
  body?: object,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: cfg.host,
        port: cfg.port,
        method,
        path,
        headers: body ? { "content-type": "application/json" } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = null;
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

export class DiscordChildClient {
  constructor(private readonly cfg: DiscordChildClientConfig) {}

  async postMessage(
    payload: DiscordPostMessageRequest,
  ): Promise<DiscordPostMessageResponse> {
    const res = await tcp(this.cfg, "POST", "/v1/post-message", payload);
    if (res.status !== 200) {
      const detail =
        res.body && typeof res.body === "object" && "error" in res.body
          ? (res.body as { error: string }).error
          : String(res.status);
      throw new Error(`child-discord post-message failed: ${detail}`);
    }
    return res.body as DiscordPostMessageResponse;
  }
}
