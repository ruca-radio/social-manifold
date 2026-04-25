export interface DiscordPostMessageRequest {
  persona_id: string;
  guild_id: string;
  channel_id: string;
  content: string;
  idempotency_key: string;
}

export interface DiscordPostMessageResponse {
  message_id: string;
  channel_id: string;
}

export interface DiscordPostMessageError {
  error: string;
  detail?: string;
}
