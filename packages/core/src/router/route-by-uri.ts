export interface DiscordCommunityRef {
  platform: "discord";
  guild_id: string;
  channel_id: string;
}

export type CommunityRef = DiscordCommunityRef;

const DISCORD = /^discord:\/\/guild:(\d+)\/channel:(\d+)$/;

export function parseCommunityRef(ref: string): CommunityRef | null {
  const m = ref.match(DISCORD);
  if (m) {
    return { platform: "discord", guild_id: m[1], channel_id: m[2] };
  }
  return null;
}
