/**
 * Apple Music catalog album metadata enrichment.
 *
 * The iTunes Search enrichment in services/itunes/enrich.ts runs at
 * track-level (entity=song) and captures the album's apple_music_id +
 * apple_music_url as a side-effect of every track lookup. It does NOT
 * call back into the album endpoint to capture release date or track
 * count, so we never see those.
 *
 * This service does the album-level lookup separately, against Apple
 * Music's catalog API (requires the JWT we already store as
 * APPLE_MUSIC_DEVELOPER_TOKEN — same token the image pipeline uses).
 *
 *   GET https://api.music.apple.com/v1/catalog/us/albums/{id}
 *
 * Returns release date (ISO 8601), track count, genre names, and richer
 * fields. We persist released_year + total_tracks; the rest is logged
 * but not stored (yet).
 *
 * Idempotent — safe to re-run; the apple_music_enriched_at column gates
 * a 90-day refresh so we don't hammer the catalog every cron tick.
 */

import { and, desc, eq, isNull, lt, or, sql, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { lastfmAlbums } from '../../db/schema/lastfm.js';

const CATALOG_BASE = 'https://api.music.apple.com/v1/catalog/us/albums';
const NINETY_DAYS_AGO_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')";

interface CatalogAlbumAttributes {
  name?: string;
  artistName?: string;
  releaseDate?: string; // ISO 8601 date (YYYY-MM-DD)
  trackCount?: number;
  genreNames?: string[];
}

interface CatalogAlbumResponse {
  data?: Array<{
    id: string;
    type: 'albums';
    attributes?: CatalogAlbumAttributes;
  }>;
}

export interface AlbumMetadata {
  released_year: number | null;
  total_tracks: number | null;
}

/**
 * Fetch one album's catalog metadata. Returns nulls on any failure
 * (404, network timeout, malformed body) so callers can persist a
 * `apple_music_enriched_at` timestamp without leaving partial state.
 */
export async function fetchAlbumMetadata(
  developerToken: string,
  appleMusicId: number
): Promise<AlbumMetadata> {
  const url = `${CATALOG_BASE}/${appleMusicId}`;
  let body: CatalogAlbumResponse;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${developerToken}` },
    });
    if (!resp.ok) {
      // 404 means the album was removed from Apple Music's catalog (rare,
      // but happens for region-restricted releases). 401/403 means our
      // JWT expired — log and treat as a soft-fail.
      console.log(
        `[WARN] Apple Music /albums/${appleMusicId} returned ${resp.status}`
      );
      return { released_year: null, total_tracks: null };
    }
    body = (await resp.json()) as CatalogAlbumResponse;
  } catch (err) {
    console.log(
      `[WARN] Apple Music album fetch failed for ${appleMusicId}: ${err instanceof Error ? err.message : String(err)}`
    );
    return { released_year: null, total_tracks: null };
  }

  const attrs = body.data?.[0]?.attributes;
  if (!attrs) return { released_year: null, total_tracks: null };

  const released_year = attrs.releaseDate
    ? parseYearFromIsoDate(attrs.releaseDate)
    : null;
  const total_tracks =
    typeof attrs.trackCount === 'number' && attrs.trackCount > 0
      ? attrs.trackCount
      : null;

  return { released_year, total_tracks };
}

function parseYearFromIsoDate(s: string): number | null {
  // Apple Music returns either "YYYY-MM-DD" or sometimes just "YYYY".
  const m = s.match(/^(\d{4})/);
  if (!m) return null;
  const y = parseInt(m[1]);
  if (!Number.isFinite(y) || y < 1900 || y > 2100) return null;
  return y;
}

/**
 * Backfill released_year + total_tracks for albums that have an
 * apple_music_id but haven't been enriched yet (or are >90d stale).
 * Capped per invocation. Returns counts for cron logging.
 */
export async function backfillAppleMusicAlbums(
  db: Database,
  developerToken: string,
  batchSize = 200
): Promise<{ filled: number; skipped: number }> {
  const candidates = await db
    .select({
      id: lastfmAlbums.id,
      appleMusicId: lastfmAlbums.appleMusicId,
    })
    .from(lastfmAlbums)
    .where(
      and(
        eq(lastfmAlbums.isFiltered, 0),
        sql`${lastfmAlbums.appleMusicId} IS NOT NULL`,
        or(
          isNull(lastfmAlbums.appleMusicEnrichedAt),
          lt(lastfmAlbums.appleMusicEnrichedAt, sql.raw(NINETY_DAYS_AGO_SQL))
        )
      )
    )
    .orderBy(desc(lastfmAlbums.playcount))
    .limit(batchSize);

  let filled = 0;
  let skipped = 0;
  for (const a of candidates) {
    if (a.appleMusicId == null) {
      skipped++;
      continue;
    }
    const meta = await fetchAlbumMetadata(developerToken, a.appleMusicId);
    const now = new Date().toISOString();
    await db
      .update(lastfmAlbums)
      .set({
        releasedYear: meta.released_year,
        totalTracks: meta.total_tracks,
        appleMusicEnrichedAt: now,
        updatedAt: now,
      })
      .where(eq(lastfmAlbums.id, a.id));
    if (meta.released_year || meta.total_tracks) filled++;
    else skipped++;
  }

  return { filled, skipped };
}

/**
 * Lazy-fill a small set of albums on demand — used by the artist /
 * top-tracks routes when albums in a result set are missing metadata
 * AND they have an apple_music_id we can use right now. Caller passes
 * the set of album ids returned; we fetch+persist any that haven't
 * been enriched yet, then re-read the row.
 *
 * Bounded so a request to a heavy artist doesn't trigger 50 Apple
 * Music calls in line — caps at 8 lookups per request.
 */
export async function lazyEnrichAppleMusicAlbums(
  db: Database,
  developerToken: string,
  albumIds: number[]
): Promise<{ enriched: number }> {
  if (albumIds.length === 0) return { enriched: 0 };
  const candidates = await db
    .select({
      id: lastfmAlbums.id,
      appleMusicId: lastfmAlbums.appleMusicId,
    })
    .from(lastfmAlbums)
    .where(
      and(
        inArray(lastfmAlbums.id, albumIds),
        isNull(lastfmAlbums.appleMusicEnrichedAt),
        sql`${lastfmAlbums.appleMusicId} IS NOT NULL`
      )
    )
    .limit(8);

  let enriched = 0;
  for (const a of candidates) {
    if (a.appleMusicId == null) continue;
    const meta = await fetchAlbumMetadata(developerToken, a.appleMusicId);
    const now = new Date().toISOString();
    await db
      .update(lastfmAlbums)
      .set({
        releasedYear: meta.released_year,
        totalTracks: meta.total_tracks,
        appleMusicEnrichedAt: now,
        updatedAt: now,
      })
      .where(eq(lastfmAlbums.id, a.id));
    enriched++;
  }
  return { enriched };
}
