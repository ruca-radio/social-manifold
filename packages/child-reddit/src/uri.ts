export interface RedditCommunityRef {
  subreddit: string;
}

const REDDIT = /^reddit:\/\/r\/([A-Za-z0-9_]{3,21})$/;

export function parseRedditRef(ref: string): RedditCommunityRef | null {
  const m = ref.match(REDDIT);
  if (!m) return null;
  return { subreddit: m[1] };
}
