export interface DiscordCommunityRef {
  guild_id: string;
  channel_id: string;
}

const DISCORD = /^discord:\/\/guild:(\d+)\/channel:(\d+)$/;

export function parseDiscordRef(ref: string): DiscordCommunityRef | null {
  const m = ref.match(DISCORD);
  if (!m) return null;
  return { guild_id: m[1], channel_id: m[2] };
}
