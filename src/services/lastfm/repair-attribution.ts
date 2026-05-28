/**
 * Album-attribution-repair Phase 3 — split/collapse the comp-flagged
 * album rows that migration 0018 over-merged across artists.
 *
 * Three actions per album, picked by classifier:
 *   - KEEP_AS_VA            : real compilation (soundtrack, tribute, NOW
 *                             comp, etc.). Re-attribute album.artist_id
 *                             to the canonical Various Artists row; the
 *                             tracks already point at it.
 *   - COLLAPSE_TO_PRIMARY   : single-cluster album where Last.fm reported
 *                             credit variants as separate artists (e.g.
 *                             COWBOY CARTER's 9 feature credits, plus
 *                             Beyoncé). Repoint all tracks to a per-artist
 *                             row owned by the cluster artist.
 *   - SPLIT_PER_ARTIST      : name collision — multiple artists' identically
 *                             named albums were merged (Greatest Hits,
 *                             MTV Unplugged, BBC Sessions). Mint one new
 *                             album row per track artist; repoint that
 *                             artist's tracks.
 *
 * When the album_artist is itself one of the track artists, we keep the
 * original row (and its existing image) as that artist's split. Other
 * artists get new rows; Phase 4's image pipeline fills in their art.
 *
 * Every action writes a row to lastfm_album_attribution_audit so the
 * migration is reviewable and reversible.
 *
 * See docs/projects/album-attribution-repair/README.md for the full plan.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  lastfmAlbumAttributionAudit,
  lastfmAlbums,
  lastfmArtists,
  lastfmScrobbles,
  lastfmTopAlbums,
  lastfmTracks,
} from '../../db/schema/lastfm.js';
import { images } from '../../db/schema/system.js';
import { getVariousArtistsId } from './constants.js';

export type RepairAction =
  | 'KEEP_AS_VA'
  | 'COLLAPSE_TO_PRIMARY'
  | 'SPLIT_PER_ARTIST';

export interface ArtistShare {
  artistId: number;
  artistName: string;
  trackCount: number;
}

export interface PlannedRepair {
  albumId: number;
  albumName: string;
  originalArtistId: number;
  originalArtistName: string;
  distinctArtists: number;
  totalTracks: number;
  action: RepairAction;
  primaryArtist?: ArtistShare; // for COLLAPSE_TO_PRIMARY
  artistShares: ArtistShare[]; // top contributors (capped at 5 for CSV)
  notes: string;
}

export interface RepairSummary {
  total: number;
  byAction: Record<RepairAction, number>;
  albumsCreated: number;
  tracksMoved: number;
  auditRowsWritten: number;
}

// Soundtrack / tribute / box-set / playlist name patterns. Inclusive on
// purpose — false positives keep an album grouped as Various Artists
// (reversible). False negatives split a real comp into per-artist rows
// which is harder to undo.
const COMP_NAME_PATTERN =
  /soundtrack|original motion|original tv|music from|music of|ost\b|awesome mix|mixtape|tribute|treasury|tarantino|spotify (sessions|singles)|essentials|spectacle|best of|the best of|live at|live from|playlist|anthology|box set|chess box|red hot compilation|judgement night|christmas number|the album/i;

// An artist counts as a "cluster" when they have at least this many
// tracks on a comp-flagged album. Soundtracks rarely cluster; name
// collisions do (Aerosmith Greatest Hits = 35 Aerosmith tracks).
const CLUSTER_THRESHOLD = 3;

// A 0-cluster album with at least this many distinct artists, each
// contributing at most 2 tracks, is shaped like a true compilation
// even if the name doesn't match the regex.
const SHAPE_COMP_MIN_DISTINCT_ARTISTS = 7;
const SHAPE_COMP_MAX_TRACKS_PER_ARTIST = 2;

interface CompAlbumRow {
  albumId: number;
  albumName: string;
  artistId: number;
  artistName: string;
  mbid: string | null;
  url: string | null;
}

interface TrackShareRow {
  albumId: number;
  artistId: number;
  artistName: string;
  trackCount: number;
}

async function loadCandidates(db: Database): Promise<{
  albums: CompAlbumRow[];
  shares: Map<number, TrackShareRow[]>;
}> {
  const albumRows = await db
    .select({
      albumId: lastfmAlbums.id,
      albumName: lastfmAlbums.name,
      artistId: lastfmAlbums.artistId,
      artistName: lastfmArtists.name,
      mbid: lastfmAlbums.mbid,
      url: lastfmAlbums.url,
    })
    .from(lastfmAlbums)
    .leftJoin(lastfmArtists, eq(lastfmAlbums.artistId, lastfmArtists.id))
    .where(eq(lastfmAlbums.isCompilation, 1));

  const albums: CompAlbumRow[] = albumRows.map((r) => ({
    albumId: r.albumId,
    albumName: r.albumName,
    artistId: r.artistId,
    artistName: r.artistName ?? '',
    mbid: r.mbid,
    url: r.url,
  }));

  const shareRows = await db
    .select({
      albumId: lastfmTracks.albumId,
      artistId: lastfmTracks.artistId,
      artistName: lastfmArtists.name,
      trackCount: sql<number>`count(*)`,
    })
    .from(lastfmTracks)
    .innerJoin(
      lastfmAlbums,
      and(
        eq(lastfmTracks.albumId, lastfmAlbums.id),
        eq(lastfmAlbums.isCompilation, 1)
      )
    )
    .leftJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .groupBy(lastfmTracks.albumId, lastfmTracks.artistId);

  const shares = new Map<number, TrackShareRow[]>();
  for (const r of shareRows) {
    if (r.albumId === null) continue;
    const arr = shares.get(r.albumId) ?? [];
    arr.push({
      albumId: r.albumId,
      artistId: r.artistId,
      artistName: r.artistName ?? '',
      trackCount: Number(r.trackCount),
    });
    shares.set(r.albumId, arr);
  }
  for (const arr of shares.values()) {
    arr.sort((a, b) => b.trackCount - a.trackCount);
  }
  return { albums, shares };
}

function classify(
  album: CompAlbumRow,
  artistShares: TrackShareRow[]
): { action: RepairAction; notes: string; primaryArtist?: ArtistShare } {
  const clusters = artistShares.filter(
    (s) => s.trackCount >= CLUSTER_THRESHOLD
  );
  const looksLikeComp = COMP_NAME_PATTERN.test(album.albumName);
  const shapeLikeComp =
    clusters.length === 0 &&
    artistShares.length >= SHAPE_COMP_MIN_DISTINCT_ARTISTS &&
    (artistShares[0]?.trackCount ?? 0) <= SHAPE_COMP_MAX_TRACKS_PER_ARTIST;

  if (clusters.length === 0) {
    if (looksLikeComp || shapeLikeComp) {
      return { action: 'KEEP_AS_VA', notes: 'no clusters, comp-shape/name' };
    }
    return { action: 'SPLIT_PER_ARTIST', notes: 'no clusters, sparse anomaly' };
  }
  if (clusters.length === 1) {
    return {
      action: 'COLLAPSE_TO_PRIMARY',
      notes: `single cluster (${clusters[0].artistName}: ${clusters[0].trackCount})`,
      primaryArtist: {
        artistId: clusters[0].artistId,
        artistName: clusters[0].artistName,
        trackCount: clusters[0].trackCount,
      },
    };
  }
  if (looksLikeComp) {
    return {
      action: 'KEEP_AS_VA',
      notes: `${clusters.length} clusters but comp-named — preserving group`,
    };
  }
  return {
    action: 'SPLIT_PER_ARTIST',
    notes: `${clusters.length} clusters, name collision`,
  };
}

export async function planRepair(db: Database): Promise<PlannedRepair[]> {
  const { albums, shares } = await loadCandidates(db);

  return albums
    .map((album) => {
      const artistShares = shares.get(album.albumId) ?? [];
      const { action, notes, primaryArtist } = classify(album, artistShares);
      const totalTracks = artistShares.reduce(
        (sum, s) => sum + s.trackCount,
        0
      );
      return {
        albumId: album.albumId,
        albumName: album.albumName,
        originalArtistId: album.artistId,
        originalArtistName: album.artistName,
        distinctArtists: artistShares.length,
        totalTracks,
        action,
        primaryArtist,
        artistShares: artistShares.slice(0, 5).map((s) => ({
          artistId: s.artistId,
          artistName: s.artistName,
          trackCount: s.trackCount,
        })),
        notes,
      };
    })
    .sort((a, b) => {
      if (a.action !== b.action) return a.action.localeCompare(b.action);
      return b.distinctArtists - a.distinctArtists;
    });
}

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function planToCsv(plan: PlannedRepair[]): string {
  const header = [
    'album_id',
    'album_name',
    'original_artist',
    'action',
    'distinct_artists',
    'total_tracks',
    'top1_artist',
    'top1_tracks',
    'top2_artist',
    'top2_tracks',
    'top3_artist',
    'top3_tracks',
    'notes',
  ].join(',');
  const rows = plan.map((p) =>
    [
      p.albumId,
      csvEscape(p.albumName),
      csvEscape(p.originalArtistName),
      p.action,
      p.distinctArtists,
      p.totalTracks,
      csvEscape(p.artistShares[0]?.artistName),
      p.artistShares[0]?.trackCount ?? '',
      csvEscape(p.artistShares[1]?.artistName),
      p.artistShares[1]?.trackCount ?? '',
      csvEscape(p.artistShares[2]?.artistName),
      p.artistShares[2]?.trackCount ?? '',
      csvEscape(p.notes),
    ].join(',')
  );
  return [header, ...rows].join('\n');
}

async function insertAuditRow(
  db: Database,
  row: {
    originalAlbumId: number;
    originalAlbumName: string;
    originalArtistId: number | null;
    action: RepairAction;
    newAlbumId: number | null;
    newArtistId: number | null;
    tracksMoved: number;
    notes: string;
  }
): Promise<void> {
  await db.insert(lastfmAlbumAttributionAudit).values(row);
}

async function recomputePlaycount(
  db: Database,
  albumId: number
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(eq(lastfmTracks.albumId, albumId));
  const playcount = Number(row?.n ?? 0);
  await db
    .update(lastfmAlbums)
    .set({ playcount, updatedAt: new Date().toISOString() })
    .where(eq(lastfmAlbums.id, albumId));
  return playcount;
}

async function clearAlbumDependents(
  db: Database,
  albumId: number
): Promise<void> {
  // Phase 5 rebuilds top_albums; the per-album image was already
  // repointed by the caller when we wanted to retain it.
  await db.delete(lastfmTopAlbums).where(eq(lastfmTopAlbums.albumId, albumId));
  await db
    .delete(images)
    .where(
      and(
        eq(images.domain, 'listening'),
        eq(images.entityType, 'albums'),
        eq(images.entityId, String(albumId))
      )
    );
}

async function findOrMintAlbumRow(
  db: Database,
  album: CompAlbumRow,
  newArtistId: number
): Promise<{ id: number; created: boolean }> {
  const [existing] = await db
    .select({ id: lastfmAlbums.id })
    .from(lastfmAlbums)
    .where(
      and(
        eq(lastfmAlbums.name, album.albumName),
        eq(lastfmAlbums.artistId, newArtistId)
      )
    )
    .limit(1);
  if (existing) return { id: existing.id, created: false };

  const [inserted] = await db
    .insert(lastfmAlbums)
    .values({
      userId: 1,
      name: album.albumName,
      artistId: newArtistId,
      mbid: album.mbid,
      url: album.url,
      isFiltered: 0,
      isCompilation: 0,
    })
    .returning({ id: lastfmAlbums.id });
  return { id: inserted.id, created: true };
}

async function applyKeepAsVa(
  db: Database,
  album: CompAlbumRow,
  variousArtistsId: number,
  notes: string
): Promise<{ tracksMoved: number }> {
  const [tracksRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(lastfmTracks)
    .where(eq(lastfmTracks.albumId, album.albumId));
  const tracksMoved = Number(tracksRow?.n ?? 0);

  await db
    .update(lastfmAlbums)
    .set({
      artistId: variousArtistsId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(lastfmAlbums.id, album.albumId));

  await recomputePlaycount(db, album.albumId);

  await insertAuditRow(db, {
    originalAlbumId: album.albumId,
    originalAlbumName: album.albumName,
    originalArtistId: album.artistId,
    action: 'KEEP_AS_VA',
    newAlbumId: album.albumId,
    newArtistId: variousArtistsId,
    tracksMoved,
    notes,
  });
  return { tracksMoved };
}

async function applyCollapse(
  db: Database,
  album: CompAlbumRow,
  primary: ArtistShare,
  notes: string
): Promise<{ newAlbumId: number; tracksMoved: number; created: boolean }> {
  const { id: newAlbumId, created } = await findOrMintAlbumRow(
    db,
    album,
    primary.artistId
  );
  const isSameRow = newAlbumId === album.albumId;

  const [tracksRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(lastfmTracks)
    .where(eq(lastfmTracks.albumId, album.albumId));
  const tracksMoved = Number(tracksRow?.n ?? 0);

  if (!isSameRow) {
    await db
      .update(lastfmTracks)
      .set({ albumId: newAlbumId, updatedAt: new Date().toISOString() })
      .where(eq(lastfmTracks.albumId, album.albumId));

    // Inherit the original cover (the comp row represented this primary
    // artist's album anyway).
    await db
      .update(images)
      .set({ entityId: String(newAlbumId) })
      .where(
        and(
          eq(images.domain, 'listening'),
          eq(images.entityType, 'albums'),
          eq(images.entityId, String(album.albumId))
        )
      );

    await clearAlbumDependents(db, album.albumId);
    await db.delete(lastfmAlbums).where(eq(lastfmAlbums.id, album.albumId));
  } else {
    // Keeping the original row — flip is_compilation off so the row is
    // honest about its identity going forward.
    await db
      .update(lastfmAlbums)
      .set({ isCompilation: 0, updatedAt: new Date().toISOString() })
      .where(eq(lastfmAlbums.id, album.albumId));
  }

  await recomputePlaycount(db, newAlbumId);

  await insertAuditRow(db, {
    originalAlbumId: album.albumId,
    originalAlbumName: album.albumName,
    originalArtistId: album.artistId,
    action: 'COLLAPSE_TO_PRIMARY',
    newAlbumId,
    newArtistId: primary.artistId,
    tracksMoved,
    notes,
  });

  return { newAlbumId, tracksMoved, created };
}

async function applySplit(
  db: Database,
  album: CompAlbumRow,
  artistShares: TrackShareRow[],
  notes: string
): Promise<{ newAlbumIds: number[]; tracksMoved: number; created: number }> {
  const newAlbumIds: number[] = [];
  let tracksMoved = 0;
  let albumsCreated = 0;
  let keptOriginal = false;

  for (const share of artistShares) {
    const isOriginalArtist = share.artistId === album.artistId;
    let targetId: number;

    if (isOriginalArtist) {
      // The album_artist's split inherits the original row (and its
      // cover art). Drop is_compilation so the row is honest.
      targetId = album.albumId;
      keptOriginal = true;
      await db
        .update(lastfmAlbums)
        .set({ isCompilation: 0, updatedAt: new Date().toISOString() })
        .where(eq(lastfmAlbums.id, album.albumId));
    } else {
      const { id, created } = await findOrMintAlbumRow(
        db,
        album,
        share.artistId
      );
      targetId = id;
      if (created) albumsCreated++;
      await db
        .update(lastfmTracks)
        .set({ albumId: targetId, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(lastfmTracks.albumId, album.albumId),
            eq(lastfmTracks.artistId, share.artistId)
          )
        );
      tracksMoved += share.trackCount;
    }

    newAlbumIds.push(targetId);
    await recomputePlaycount(db, targetId);

    await insertAuditRow(db, {
      originalAlbumId: album.albumId,
      originalAlbumName: album.albumName,
      originalArtistId: album.artistId,
      action: 'SPLIT_PER_ARTIST',
      newAlbumId: targetId,
      newArtistId: share.artistId,
      tracksMoved: share.trackCount,
      notes: isOriginalArtist
        ? `${notes} (kept original row + image)`
        : `${notes} (image deferred to Phase 4)`,
    });
  }

  // If the album_artist wasn't on the track list (rare — the comp row
  // was attributed to someone with no tracks on it), the original row
  // has been fully drained.
  if (!keptOriginal) {
    const [orphans] = await db
      .select({ n: sql<number>`count(*)` })
      .from(lastfmTracks)
      .where(eq(lastfmTracks.albumId, album.albumId));
    if (Number(orphans?.n ?? 0) === 0) {
      await clearAlbumDependents(db, album.albumId);
      await db.delete(lastfmAlbums).where(eq(lastfmAlbums.id, album.albumId));
    } else {
      console.log(
        `[REPAIR] album ${album.albumId} has ${orphans?.n} orphans after split — leaving row for manual review`
      );
    }
  }

  return { newAlbumIds, tracksMoved, created: albumsCreated };
}

export async function applyRepair(db: Database): Promise<RepairSummary> {
  const variousArtistsId = await getVariousArtistsId(db);
  if (variousArtistsId === null) {
    throw new Error(
      '[REPAIR] Various Artists row not seeded — apply migration 0038 first'
    );
  }

  const { albums, shares } = await loadCandidates(db);
  const summary: RepairSummary = {
    total: albums.length,
    byAction: {
      KEEP_AS_VA: 0,
      COLLAPSE_TO_PRIMARY: 0,
      SPLIT_PER_ARTIST: 0,
    },
    albumsCreated: 0,
    tracksMoved: 0,
    auditRowsWritten: 0,
  };

  for (const album of albums) {
    const artistShares = shares.get(album.albumId) ?? [];
    const { action, notes, primaryArtist } = classify(album, artistShares);
    summary.byAction[action]++;

    switch (action) {
      case 'KEEP_AS_VA': {
        const { tracksMoved } = await applyKeepAsVa(
          db,
          album,
          variousArtistsId,
          notes
        );
        summary.tracksMoved += tracksMoved;
        summary.auditRowsWritten++;
        break;
      }
      case 'COLLAPSE_TO_PRIMARY': {
        if (!primaryArtist) break;
        const { tracksMoved, created } = await applyCollapse(
          db,
          album,
          primaryArtist,
          notes
        );
        summary.tracksMoved += tracksMoved;
        if (created) summary.albumsCreated++;
        summary.auditRowsWritten++;
        break;
      }
      case 'SPLIT_PER_ARTIST': {
        const result = await applySplit(db, album, artistShares, notes);
        summary.tracksMoved += result.tracksMoved;
        summary.albumsCreated += result.created;
        summary.auditRowsWritten += artistShares.length;
        break;
      }
    }
  }

  return summary;
}
