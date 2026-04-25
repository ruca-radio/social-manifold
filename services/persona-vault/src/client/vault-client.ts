import { request } from "node:http";
import { Credential } from "./credential.js";

export interface CredentialRequest {
  requester_id: string;
  purpose: string;
}

interface RawResponse {
  status: number;
  body: unknown;
}

function uds(
  socketPath: string,
  method: string,
  path: string,
  body?: object,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
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

export class VaultClient {
  constructor(private readonly socketPath: string) {}

  async listPersonas(): Promise<string[]> {
    const res = await uds(this.socketPath, "GET", "/v1/personas");
    if (res.status !== 200) {
      throw new Error(`vault listPersonas failed: ${res.status}`);
    }
    return (res.body as { personas: string[] }).personas;
  }

  async listPlatforms(personaId: string): Promise<string[]> {
    const res = await uds(
      this.socketPath,
      "GET",
      `/v1/personas/${encodeURIComponent(personaId)}/platforms`,
    );
    if (res.status !== 200) {
      throw new Error(
        `vault listPlatforms failed for ${personaId}: ${res.status}`,
      );
    }
    return (res.body as { platforms: string[] }).platforms;
  }

  async getCredential(
    personaId: string,
    platform: string,
    request: CredentialRequest,
  ): Promise<Credential> {
    if (!request.requester_id || !request.purpose) {
      throw new Error("vault.getCredential: requester_id and purpose required");
    }
    const res = await uds(
      this.socketPath,
      "POST",
      `/v1/personas/${encodeURIComponent(personaId)}/credentials/${encodeURIComponent(platform)}`,
      request,
    );
    if (res.status !== 200) {
      const detail =
        res.body && typeof res.body === "object" && "error" in res.body
          ? (res.body as { error: string }).error
          : String(res.status);
      throw new Error(
        `vault.getCredential(${personaId}, ${platform}): ${detail}`,
      );
    }
    const payload = res.body as { credential: Record<string, string> };
    return new Credential(payload.credential);
  }
}
