/**
 * Extract the scheme from a community_ref URI.
 *
 * Children own the parsing of their own URI sub-format; the core only
 * needs the scheme to choose which child MCP to forward to. See
 * CLAUDE.md §7.5 — Core ↔ child MCP transport.
 */
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//;

export function getScheme(ref: string): string | null {
  const m = ref.match(SCHEME);
  return m ? m[1] : null;
}
