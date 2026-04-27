/**
 * Last.fm artist enrichment — bio (`artist.getInfo`) and similar artists
 * (`artist.getSimilar`).
 *
 * - `enrichArtistBio` is called lazily from the artist detail route on first
 *   render when `bio_content IS NULL`. Cheap (~200ms via client rate limit).
 *   Refresh after 90 days via `bio_synced_at`.
 *
 * - `enrichArtistSimilar` is eager-synced for the user's top-200 artists by
 *   playcount via the daily 3:00 AM cron. Long-tail artists get
 *   `similar_artists = NULL` until they enter the top-200.
 *
 *   Similar-artists are intersected with the user's own `lastfm_artists`
 *   table at storage time so we only persist artists the user has also
 *   listened to. Generic Last.fm "similar" suggestions are dropped.
 */

import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { lastfmArtists } from '../../db/schema/lastfm.js';
import type { LastfmClient } from './client.js';

const NINETY_DAYS_AGO_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')";

export interface SimilarArtistEntry {
  artist_id: number;
  name: string;
  mbid: string | null;
  similarity_score: number;
}

/**
 * Strip Last.fm's CDATA / "Read more on Last.fm" link from a bio string.
 * Last.fm's API returns bios with an HTML anchor appended; we keep the
 * prose, drop the link.
 */
export function stripLastfmBioLink(
  s: string | null | undefined
): string | null {
  if (!s) return null;
  // Remove the "<a href=\"...\">Read more on Last.fm</a>." trailer.
  const noLink = s.replace(
    /\s*<a [^>]*>Read more on Last\.fm<\/a>\s*\.?\s*$/i,
    ''
  );
  // CDATA-wrapped responses sometimes leak. Drop wrappers.
  return (
    noLink
      .replace(/^<!\[CDATA\[/, '')
      .replace(/\]\]>$/, '')
      .trim() || null
  );
}

/**
 * Lazy-fill bio for one artist. Called from the artist detail route when
 * `bio_content IS NULL`. Persists `bio_summary`, `bio_content`,
 * `bio_synced_at`. Returns the persisted summary + content so the route
 * handler can use them in the same request.
 */
export async function enrichArtistBio(
  db: Database,
  client: LastfmClient,
  artist: {
    id: number;
    name: string;
    mbid: string | null;
  }
): Promise<{ bio_summary: string | null; bio_content: string | null }> {
  let info;
  try {
    info = await client.getArtistInfo({ mbid: artist.mbid, name: artist.name });
  } catch (err) {
    console.warn(
      `[WARN] Last.fm getArtistInfo failed for ${artist.name}: ${(err as Error).message}`
    );
    return { bio_summary: null, bio_content: null };
  }

  const bio_summary = stripLastfmBioLink(info.artist?.bio?.summary ?? null);
  const bio_content = stripLastfmBioLink(info.artist?.bio?.content ?? null);
  const now = new Date().toISOString();

  await db
    .update(lastfmArtists)
    .set({
      bioSummary: bio_summary,
      bioContent: bio_content,
      bioSyncedAt: now,
      updatedAt: now,
    })
    .where(eq(lastfmArtists.id, artist.id));

  return { bio_summary, bio_content };
}

/**
 * Eager-fill similar artists for one artist. Persists the intersection
 * (similar ∩ user's lastfm_artists) as JSON. Returns the count of
 * persisted entries.
 */
export async function enrichArtistSimilar(
  db: Database,
  client: LastfmClient,
  artist: {
    id: number;
    name: string;
    mbid: string | null;
  },
  userId = 1
): Promise<{ persisted: number }> {
  let resp;
  try {
    resp = await client.getArtistSimilar({
      mbid: artist.mbid,
      name: artist.name,
      limit: 50,
    });
  } catch (err) {
    console.warn(
      `[WARN] Last.fm getArtistSimilar failed for ${artist.name}: ${(err as Error).message}`
    );
    // Persist `similar_synced_at` anyway so we don't retry on every cron tick.
    const now = new Date().toISOString();
    await db
      .update(lastfmArtists)
      .set({ similarSyncedAt: now, updatedAt: now })
      .where(eq(lastfmArtists.id, artist.id));
    return { persisted: 0 };
  }

  const candidates = resp.similarartists?.artist ?? [];
  if (candidates.length === 0) {
    const now = new Date().toISOString();
    await db
      .update(lastfmArtists)
      .set({
        similarArtists: JSON.stringify([]),
        similarSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(lastfmArtists.id, artist.id));
    return { persisted: 0 };
  }

  // Intersect with the user's own artists. Match by mbid first (when both
  // sides have one), else by case-insensitive name. Drop entries with no
  // local match — that's what "similar artists you've also listened to"
  // means.
  const candidateMbids = candidates
    .map((c) => c.mbid)
    .filter((m): m is string => Boolean(m));
  const candidateNames = candidates.map((c) => c.name.toLowerCase());

  const localMatches = await db
    .select({
      id: lastfmArtists.id,
      name: lastfmArtists.name,
      mbid: lastfmArtists.mbid,
    })
    .from(lastfmArtists)
    .where(
      and(
        eq(lastfmArtists.userId, userId),
        eq(lastfmArtists.isFiltered, 0),
        or(
          candidateMbids.length > 0
            ? inArray(lastfmArtists.mbid, candidateMbids)
            : sql`0 = 1`,
          inArray(sql`lower(${lastfmArtists.name})`, candidateNames)
        )
      )
    );

  const byMbid = new Map(
    localMatches.filter((m) => m.mbid).map((m) => [m.mbid as string, m])
  );
  const byName = new Map(localMatches.map((m) => [m.name.toLowerCase(), m]));

  const intersection: SimilarArtistEntry[] = [];
  const seen = new Set<number>();
  for (const c of candidates) {
    const local =
      (c.mbid ? byMbid.get(c.mbid) : undefined) ??
      byName.get(c.name.toLowerCase());
    if (!local || seen.has(local.id)) continue;
    seen.add(local.id);
    const score = parseFloat(c.match);
    intersection.push({
      artist_id: local.id,
      name: local.name,
      mbid: local.mbid ?? null,
      similarity_score: Number.isFinite(score) ? score : 0,
    });
  }

  const now = new Date().toISOString();
  await db
    .update(lastfmArtists)
    .set({
      similarArtists: JSON.stringify(intersection),
      similarSyncedAt: now,
      updatedAt: now,
    })
    .where(eq(lastfmArtists.id, artist.id));

  return { persisted: intersection.length };
}

/**
 * Backfill `similar_artists` for the top-N artists by playcount whose
 * cached entry is missing or older than 90 days. Called from the daily
 * cron alongside top-list sync. ~3.5 req/s sustained at N=200.
 */
export async function backfillSimilarArtistsForTop(
  db: Database,
  client: LastfmClient,
  topN = 200,
  userId = 1
): Promise<{ refreshed: number; checked: number }> {
  const candidates = await db
    .select({
      id: lastfmArtists.id,
      name: lastfmArtists.name,
      mbid: lastfmArtists.mbid,
      similarSyncedAt: lastfmArtists.similarSyncedAt,
    })
    .from(lastfmArtists)
    .where(
      and(eq(lastfmArtists.userId, userId), eq(lastfmArtists.isFiltered, 0))
    )
    .orderBy(desc(lastfmArtists.playcount))
    .limit(topN);

  let refreshed = 0;
  for (const a of candidates) {
    if (a.similarSyncedAt) {
      // Skip if within 90d.
      const synced = new Date(a.similarSyncedAt).getTime();
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      if (Date.now() - synced < ninetyDaysMs) continue;
    }
    await enrichArtistSimilar(db, client, a, userId);
    refreshed++;
  }

  return { refreshed, checked: candidates.length };
}

/**
 * Backfill `bio_summary` + `bio_content` for any artist with playcount > 0
 * that's missing the bio or has it older than 90 days. Capped per
 * invocation. Use for the admin endpoint; not called from cron — bios are
 * lazy-filled on first render.
 */
export async function backfillArtistBios(
  db: Database,
  client: LastfmClient,
  batchSize = 100,
  userId = 1
): Promise<{ filled: number; remaining: number }> {
  const candidates = await db
    .select({
      id: lastfmArtists.id,
      name: lastfmArtists.name,
      mbid: lastfmArtists.mbid,
    })
    .from(lastfmArtists)
    .where(
      and(
        eq(lastfmArtists.userId, userId),
        eq(lastfmArtists.isFiltered, 0),
        or(
          isNull(lastfmArtists.bioContent),
          lt(lastfmArtists.bioSyncedAt, sql.raw(NINETY_DAYS_AGO_SQL))
        )
      )
    )
    .orderBy(desc(lastfmArtists.playcount))
    .limit(batchSize);

  let filled = 0;
  for (const a of candidates) {
    const out = await enrichArtistBio(db, client, a);
    if (out.bio_content || out.bio_summary) filled++;
  }

  return { filled, remaining: candidates.length - filled };
}
