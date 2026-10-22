import { and, eq, sql, type SQL } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import type { Database } from '../../db/client.js';
import {
  lastfmAlbums,
  lastfmArtists,
  lastfmTracks,
} from '../../db/schema/lastfm.js';
import { artistIdentityMatches } from '../images/sources/utils.js';
import { findArtistByName } from '../lastfm/artist-identity.js';
import { releaseTitleMatches } from './match.js';
import type { CatalogAlbum } from './catalog-album.js';

export const FILED_UNDER_ALBUM_ARTIST = 'FILE_UNDER_ALBUM_ARTIST';

/** A different recording credit is legitimate only with its owned filing proof. */
export function hasVerifiedAlbumAttribution(): SQL {
  return sql`EXISTS(SELECT 1 FROM lastfm_album_attribution_audit proof JOIN lastfm_albums source ON source.id=proof.original_album_id AND source.user_id=${lastfmTracks.userId}
    WHERE proof.action='FILE_UNDER_ALBUM_ARTIST' AND proof.new_album_id=${lastfmAlbums.id} AND proof.new_artist_id=${lastfmAlbums.artistId} AND proof.original_artist_id=${lastfmTracks.artistId} AND ${lastfmAlbums.userId}=${lastfmTracks.userId})`;
}

/** File the release under its verified album credit; never merge artist identities.
 * Cross-credit filing requires proof of the played recording's artist. Existing
 * pins, identity conflicts, exclusions and accepted source artwork are holds.
 */
export async function fileUnderCatalogArtist(
  db: Database,
  userId: number,
  albumId: number,
  catalog: CatalogAlbum,
  trackArtistVerified: boolean,
  dryRun = false,
  action:
    | typeof FILED_UNDER_ALBUM_ARTIST
    | 'FILE_UNDER_VARIOUS_ARTISTS' = FILED_UNDER_ALBUM_ARTIST
): Promise<{ albumId: number | null; changed: boolean } | null> {
  const [source] = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      artistId: lastfmAlbums.artistId,
      artist: lastfmArtists.name,
      mbid: lastfmAlbums.mbid,
      artistMbid: lastfmArtists.mbid,
      catalogId: lastfmAlbums.appleMusicId,
    })
    .from(lastfmAlbums)
    .innerJoin(
      lastfmArtists,
      and(
        eq(lastfmArtists.id, lastfmAlbums.artistId),
        eq(lastfmArtists.userId, lastfmAlbums.userId)
      )
    )
    .where(
      and(
        eq(lastfmAlbums.id, albumId),
        eq(lastfmAlbums.userId, userId),
        eq(lastfmAlbums.isFiltered, 0),
        eq(lastfmAlbums.identityConflict, 0),
        eq(lastfmAlbums.appleMusicPinned, 0),
        eq(lastfmArtists.isFiltered, 0),
        eq(lastfmArtists.identityConflict, 0)
      )
    );
  if (!source || !releaseTitleMatches(source.name, catalog.name, source.artist))
    return null;
  const sameCredit = artistIdentityMatches(source.artist, catalog.artistName);
  if (
    !sameCredit &&
    !trackArtistVerified &&
    catalog.artistName.trim().toLowerCase() !== 'various artists'
  )
    return null;
  const prior = await db.get<{
    id: number;
    catalog_id: number | null;
    name: string;
    artist: string;
  }>(sql`SELECT target.id,target.apple_music_id catalog_id,target.name,r.name artist FROM lastfm_album_attribution_audit proof
    JOIN lastfm_albums target ON target.id=proof.new_album_id AND target.user_id=${userId} JOIN lastfm_artists r ON r.id=target.artist_id AND r.user_id=target.user_id
    WHERE proof.original_album_id=${source.id} AND proof.action IN ('FILE_UNDER_ALBUM_ARTIST','FILE_UNDER_VARIOUS_ARTISTS') ORDER BY proof.id DESC LIMIT 1`);
  if (prior)
    return prior.catalog_id === catalog.id &&
      artistIdentityMatches(prior.artist, catalog.artistName) &&
      releaseTitleMatches(source.name, prior.name, source.artist)
      ? { albumId: prior.id, changed: true }
      : null;
  const candidates = await db
    .select({ album: lastfmAlbums, artist: lastfmArtists })
    .from(lastfmAlbums)
    .innerJoin(
      lastfmArtists,
      and(
        eq(lastfmArtists.id, lastfmAlbums.artistId),
        eq(lastfmArtists.userId, lastfmAlbums.userId)
      )
    )
    .where(
      and(
        eq(lastfmAlbums.userId, userId),
        eq(lastfmAlbums.appleMusicId, catalog.id)
      )
    );
  const matching = candidates.filter(
    (r) =>
      artistIdentityMatches(r.artist.name, catalog.artistName) &&
      releaseTitleMatches(source.name, r.album.name, source.artist)
  );
  const albumIdentities = new Set(
    [source.mbid, ...matching.map((r) => r.album.mbid)].filter(Boolean)
  );
  const artistIdentities = new Set(
    [source.artistMbid, ...matching.map((r) => r.artist.mbid)].filter(Boolean)
  );
  if (albumIdentities.size > 1 || (sameCredit && artistIdentities.size > 1))
    return null;
  matching.sort((a, b) => a.album.id - b.album.id);
  let target = matching[0]?.album;
  if (
    target &&
    (target.isFiltered ||
      target.identityConflict ||
      matching[0].artist.isFiltered ||
      matching[0].artist.identityConflict ||
      (source.mbid && target.mbid && source.mbid !== target.mbid))
  )
    return null;
  if (target?.id === source.id || (!target && sameCredit))
    return { albumId: source.id, changed: false };
  const active = await db.get<{
    active_job: string | null;
    pinned: number;
    review_hold: number;
  }>(
    sql`SELECT active_job,pinned,review_hold FROM cd_artwork_albums WHERE user_id=${userId} AND album_id=${albumId}`
  );
  if (active?.active_job || active?.pinned || active?.review_hold) return null;
  const targetArtist = target
    ? matching[0].artist
    : await findArtistByName(db, catalog.artistName, userId);
  if (
    targetArtist &&
    (targetArtist.isFiltered || targetArtist.identityConflict)
  )
    return null;
  if (!target && targetArtist) {
    [target] = await db
      .select()
      .from(lastfmAlbums)
      .where(
        and(
          eq(lastfmAlbums.userId, userId),
          eq(lastfmAlbums.artistId, targetArtist.id),
          eq(lastfmAlbums.name, source.name)
        )
      );
    if (
      target &&
      (target.isFiltered ||
        target.identityConflict ||
        (target.appleMusicId !== null && target.appleMusicId !== catalog.id) ||
        (source.mbid && target.mbid && source.mbid !== target.mbid))
    )
      return null;
  }
  if (dryRun) return { albumId: target?.id ?? null, changed: true };
  let artistId = targetArtist?.id;
  if (!artistId) {
    await db
      .insert(lastfmArtists)
      .values({ userId, name: catalog.artistName })
      .onConflictDoNothing();
    artistId = (await findArtistByName(db, catalog.artistName, userId))?.id;
  }
  if (!artistId) return null;
  if (!target) {
    await db
      .insert(lastfmAlbums)
      .values({
        userId,
        name: source.name,
        artistId,
        appleMusicId: catalog.id,
        appleMusicUrl: catalog.url,
      })
      .onConflictDoNothing();
    [target] = await db
      .select()
      .from(lastfmAlbums)
      .where(
        and(
          eq(lastfmAlbums.userId, userId),
          eq(lastfmAlbums.artistId, artistId),
          eq(lastfmAlbums.name, source.name)
        )
      );
  }
  if (target && target.appleMusicId === null && !target.appleMusicPinned) {
    const [linked] = await db
      .update(lastfmAlbums)
      .set({ appleMusicId: catalog.id, appleMusicUrl: catalog.url })
      .where(
        and(
          eq(lastfmAlbums.id, target.id),
          eq(lastfmAlbums.userId, userId),
          eq(lastfmAlbums.name, target.name),
          eq(lastfmAlbums.artistId, target.artistId),
          sql`${lastfmAlbums.mbid} IS ${target.mbid}`,
          eq(lastfmAlbums.appleMusicPinned, 0),
          eq(lastfmAlbums.identityConflict, 0),
          eq(lastfmAlbums.isFiltered, 0),
          sql`${lastfmAlbums.appleMusicId} IS NULL`,
          sql`EXISTS(SELECT 1 FROM lastfm_artists r WHERE r.id=${target.artistId} AND r.user_id=${userId} AND r.name=${targetArtist?.name ?? catalog.artistName} AND r.mbid IS ${targetArtist?.mbid ?? null} AND r.identity_conflict=0 AND r.is_filtered=0)`
        )
      )
      .returning();
    if (linked) target = linked;
  }
  if (
    !target ||
    target.isFiltered ||
    target.identityConflict ||
    target.appleMusicId !== catalog.id
  )
    return null;
  const targetId = target.id;
  // Every write rechecks both owners and the identities read above. A stale
  // provider response cannot move plays after a pin, exclusion or catalog edit.
  const guard = sql`EXISTS(SELECT 1 FROM lastfm_albums a JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id
    JOIN lastfm_albums b ON b.id=${targetId} AND b.user_id=a.user_id JOIN lastfm_artists br ON br.id=b.artist_id AND br.user_id=b.user_id
    WHERE a.id=${source.id} AND a.user_id=${userId} AND a.name=${source.name} AND a.artist_id=${source.artistId} AND a.mbid IS ${source.mbid} AND r.name=${source.artist} AND r.mbid IS ${source.artistMbid} AND a.apple_music_id IS ${source.catalogId}
      AND a.apple_music_pinned=0 AND a.is_filtered=0 AND a.identity_conflict=0 AND r.is_filtered=0 AND r.identity_conflict=0
      AND b.apple_music_id=${catalog.id} AND b.name=${target.name} AND b.artist_id=${artistId} AND b.mbid IS ${target.mbid} AND b.is_filtered=0 AND b.identity_conflict=0 AND br.name=${targetArtist?.name ?? catalog.artistName} AND br.mbid IS ${targetArtist?.mbid ?? null} AND br.is_filtered=0 AND br.identity_conflict=0
      AND NOT EXISTS(SELECT 1 FROM lastfm_album_attribution_audit prior WHERE prior.original_album_id=a.id AND prior.action IN ('FILE_UNDER_ALBUM_ARTIST','FILE_UNDER_VARIOUS_ARTISTS') AND prior.new_album_id IS NOT ${targetId})
      AND NOT EXISTS(SELECT 1 FROM cd_artwork_albums c WHERE c.user_id=a.user_id AND c.album_id=a.id AND (c.active_job IS NOT NULL OR c.pinned=1 OR c.review_hold=1)))`;
  const timestamp = new Date().toISOString();
  const statement = (value: SQL) => {
    const query = new SQLiteAsyncDialect().sqlToQuery(value);
    return db.$client.prepare(query.sql).bind(...query.params);
  };
  await db.$client.batch([
    statement(sql`INSERT INTO lastfm_album_attribution_audit(original_album_id,original_album_name,original_artist_id,action,new_album_id,new_artist_id,tracks_moved,notes,created_at)
      SELECT ${source.id},${source.name},${source.artistId},${action},${targetId},${artistId},
      (SELECT COUNT(*) FROM lastfm_tracks WHERE user_id=${userId} AND album_id=${source.id}),${`Verified catalog album ${catalog.id}`},${timestamp}
      WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM lastfm_album_attribution_audit WHERE original_album_id=${source.id} AND new_album_id=${targetId} AND action IN ('FILE_UNDER_ALBUM_ARTIST','FILE_UNDER_VARIOUS_ARTISTS'))`),
    statement(
      sql`UPDATE lastfm_scrobbles SET album_id=${targetId} WHERE user_id=${userId} AND album_id=${source.id} AND album_recorded=1 AND ${guard}`
    ),
    statement(
      sql`UPDATE lastfm_tracks SET album_id=${targetId},updated_at=${timestamp} WHERE user_id=${userId} AND album_id=${source.id} AND ${guard}`
    ),
    statement(
      sql`UPDATE cd_artwork_albums SET discovery_outcome='album_reassigned',discovery_evidence=json_set(discovery_evidence,'$.canonical_album_id',${targetId}) WHERE user_id=${userId} AND album_id=${source.id} AND ${guard}`
    ),
  ]);
  const filed = await db.get<{ id: number }>(
    sql`SELECT id FROM lastfm_album_attribution_audit WHERE original_album_id=${source.id} AND new_album_id=${targetId} AND action IN ('FILE_UNDER_ALBUM_ARTIST','FILE_UNDER_VARIOUS_ARTISTS')`
  );
  return filed ? { albumId: targetId, changed: true } : null;
}
