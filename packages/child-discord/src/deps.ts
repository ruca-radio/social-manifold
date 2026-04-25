import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";

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
 */
export const liveDiscordRest: DiscordRestPort = {
  async postMessage(channelId, content, token) {
    const rest = new REST({ version: "10" }).setToken(token);
    const result = (await rest.post(Routes.channelMessages(channelId), {
      body: { content },
    })) as { id: string };
    return { id: result.id };
  },
};
