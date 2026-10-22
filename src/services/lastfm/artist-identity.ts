import { and, asc, eq, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { lastfmArtists } from '../../db/schema/lastfm.js';
import { cleanArtistName } from '../images/sources/utils.js';

// Fold typographic hyphens, not arbitrary punctuation or accents: distinct
// artists must not become aliases just because a catalog search accepts them.
const HYPHENS = ['‐', '‑', '‒', '–', '—', '−'];
export function artistNameKey(name: string): string {
  return cleanArtistName(name)
    .replace(/[‐‑‒–—−]/g, '-')
    .toLowerCase();
}

function storedArtistKey(column: SQL): SQL {
  let expression = column;
  for (const hyphen of HYPHENS)
    expression = sql`replace(${expression}, ${hyphen}, '-')`;
  return sql`lower(trim(${expression}))`;
}

/** Resolve only this owner's spelling aliases; conflicting MBIDs stay apart. */
export async function findArtistByName(
  db: Database,
  rawName: string,
  userId: number,
  mbid: string | null = null
) {
  const key = artistNameKey(rawName);
  // SQLite lower() folds ASCII only. For non-ASCII names compare this
  // owner's candidates in JS so stored exclusions use the same Unicode fold.
  const unicode = /\P{ASCII}/u.test(key);
  const rows = await db
    .select({
      id: lastfmArtists.id,
      name: lastfmArtists.name,
      mbid: lastfmArtists.mbid,
      appleMusicId: lastfmArtists.appleMusicId,
      isFiltered: lastfmArtists.isFiltered,
      identityConflict: lastfmArtists.identityConflict,
    })
    .from(lastfmArtists)
    .where(
      and(
        eq(lastfmArtists.userId, userId),
        unicode
          ? undefined
          : or(
              eq(lastfmArtists.name, rawName.trim()),
              sql`${storedArtistKey(sql`${lastfmArtists.name}`)} = ${key}`
            )
      )
    )
    .orderBy(asc(lastfmArtists.id));
  const candidates = rows.filter(
    (candidate) => artistNameKey(candidate.name) === key
  );
  const exact =
    candidates.find((candidate) => candidate.name === rawName.trim()) ??
    candidates.find((candidate) => candidate.name === cleanArtistName(rawName));
  // Exclusions apply to every spelling of a credit, including guest credits.
  // Do not discard a filtered row just because its identity needs review.
  const excluded = candidates.find((candidate) => candidate.isFiltered === 1);
  if (excluded) return { ...excluded, aliasIds: [excluded.id] };
  if (candidates.some((candidate) => candidate.identityConflict))
    return exact ? { ...exact, aliasIds: [exact.id] } : undefined;
  const compatible = candidates.filter(
    (candidate) =>
      !candidate.identityConflict &&
      (!mbid || !candidate.mbid || candidate.mbid === mbid)
  );
  const identities = new Set(
    compatible.map((candidate) => candidate.mbid).filter(Boolean)
  );
  const catalogIdentities = new Set(
    compatible
      .map((candidate) => candidate.appleMusicId)
      .filter((id) => id !== null)
  );
  if (identities.size <= 1 && catalogIdentities.size <= 1 && compatible.length)
    return {
      ...compatible[0],
      isFiltered: compatible.some((candidate) => candidate.isFiltered === 1)
        ? 1
        : compatible[0].isFiltered,
      aliasIds: compatible.map((candidate) => candidate.id),
    };
  // An exact stored spelling may still identify an ambiguous artist. Never
  // infer that two conflicting identities are the same spelling alias.
  return exact ? { ...exact, aliasIds: [exact.id] } : undefined;
}
