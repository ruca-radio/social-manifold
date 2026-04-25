import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { RateLimitedError } from "./adapter.js";

export interface DiscordRestPort {
  postMessage(
    channelId: string,
    content: string,
    token: string,
  ): Promise<{ id: string }>;
}

/**
 * Production REST adapter — builds a fresh @discordjs/rest client per call,
 * sets the bot token, makes the request, then drops the reference. Cred is
 * passed as a string here because we're already inside the Credential.use()
 * callback at the call site.
 *
 * 429 handling: @discordjs/rest does internal retry/queue management for
 * route-level rate limits; if it gives up and surfaces a 429, we throw
 * RateLimitedError so the mcp-server can translate to
 * VerbResult.platform_rate_limit.
 */
export const liveDiscordRest: DiscordRestPort = {
  async postMessage(channelId, content, token) {
    const rest = new REST({ version: "10" }).setToken(token);
    try {
      const result = (await rest.post(Routes.channelMessages(channelId), {
        body: { content },
      })) as { id: string };
      return { id: result.id };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 429) {
        const retryAfter =
          (err as { retryAfter?: number }).retryAfter ??
          (err as { headers?: Record<string, string> }).headers?.[
            "retry-after"
          ];
        const seconds =
          typeof retryAfter === "string"
            ? parseInt(retryAfter, 10)
            : (retryAfter ?? 30);
        throw new RateLimitedError(seconds);
      }
      throw err;
    }
  },
};
