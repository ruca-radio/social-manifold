import type { Credential } from "@social-manifold/persona-vault/client";
import type { DiscordRestPort } from "./deps.js";

export interface PostMessageInput {
  channel_id: string;
  content: string;
}

export interface PostMessageResult {
  message_id: string;
  channel_id: string;
}

/**
 * Post a message to a Discord channel.
 *
 * Credential lifecycle: the bot token is held within Credential.use() for
 * exactly the duration of the REST call, then actively cleared (see
 * services/persona-vault/src/client/credential.ts). If the REST call throws,
 * the credential is still cleared via the .use() finally block. There is
 * no path here that holds the token outside the .use() scope.
 */
export async function postMessage(
  cred: Credential,
  rest: DiscordRestPort,
  input: PostMessageInput,
): Promise<PostMessageResult> {
  return cred.use(async (raw) => {
    const token = raw.bot_token;
    if (!token) {
      throw new Error(
        "discord adapter: credential bundle is missing 'bot_token'",
      );
    }
    const { id } = await rest.postMessage(input.channel_id, input.content, token);
    return { message_id: id, channel_id: input.channel_id };
  });
}
