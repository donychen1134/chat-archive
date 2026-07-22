export const MAX_SEARCH_TOKENS = 16;

export function tokenizeSearchInput(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function quoteFtsToken(token: string): string {
  return `"${token.replaceAll(`"`, `""`)}"`;
}

export function buildFtsAnyQuery(tokens: string[]): string {
  return tokens.map(quoteFtsToken).join(" OR ");
}

export function escapeLikeToken(token: string): string {
  return `%${token.replace(/[\\%_]/g, "\\$&")}%`;
}

export function parseBoundedPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw ?? "");
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

export function excerptAroundTokens(text: string, tokens: string[], max = 160): string {
  const value = text.trim();
  if (!value || value.length <= max) return value;
  const lower = value.toLowerCase();
  const positions = tokens
    .map((token) => lower.indexOf(token.toLowerCase()))
    .filter((position) => position >= 0);
  if (positions.length === 0) return value.slice(0, max);
  const position = Math.min(...positions);
  const start = Math.max(0, Math.min(position - Math.floor(max / 3), value.length - max));
  const prefix = start > 0 ? "…" : "";
  const end = Math.min(value.length, start + max);
  const suffix = end < value.length ? "…" : "";
  return `${prefix}${value.slice(start, end)}${suffix}`;
}
