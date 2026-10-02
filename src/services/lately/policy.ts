// The provider credentials and existing ingestion belong to this owner. Do not
// populate other users' snapshots from these globally configured credentials.
export const LATELY_OWNER_ID = 1;
export const ARTWORK_WAIT_MS = 120_000;
export const LEASE_MS = 45_000;

export function movieExclusions(value = ''): number[] {
  if (!value.trim()) return [];
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length > 50) throw new Error('Too many Lately movie exclusions');
  if (
    parts.some(
      (part) => !/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(Number(part))
    )
  ) {
    throw new Error('Invalid Lately movie exclusion configuration');
  }
  return [...new Set(parts.map(Number))].sort((a, b) => a - b);
}

export function policyKey(exclusions: number[]): string {
  return JSON.stringify({ version: 1, excluded_movie_ids: exclusions });
}

// Matches the portfolio's admission guard in addition to the canonical DB
// filters. Keep recognizable audiobook filenames out even before sync flags
// catch up. No titles or personal listening history are encoded here.
export function isPublicMusic(name: string, album: string | null): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/\*/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const numbered = name.match(
    /^(?:\d{3}|\(\s*\d{1,3}\s+of\s+\d{1,3}\s*\))\s*-\s*(.+)$/i
  );
  if (numbered) {
    const a = normalize(album ?? '');
    const t = normalize(numbered[1]);
    if (a.length >= 5 && t.length >= 8 && (a.includes(t) || t.includes(a)))
      return false;
  }
  return !(
    /^libby--open-/i.test(name) ||
    /-\s*(?:part|track)\s+\d+$/i.test(name) ||
    /\s\(\d+\)$/.test(name)
  );
}
