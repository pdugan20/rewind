import { Hono } from 'hono';
import { eq, and, sql, desc, asc, like, or, inArray } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import { createDb } from '../db/client.js';
import {
  discogsReleases,
  discogsArtists,
  discogsCollection,
  discogsReleaseArtists,
  discogsWantlist,
  discogsCollectionStats,
  collectionListeningXref,
} from '../db/schema/discogs.js';
import {
  traktCollection,
  traktCollectionStats,
} from '../db/schema/trakt.js';
import { movies } from '../db/schema/watching.js';
import { watchHistory } from '../db/schema/watching.js';
import { images } from '../db/schema/system.js';
import { setCache } from '../lib/cache.js';
import { notFound, badRequest, serverError } from '../lib/errors.js';
import { TraktClient } from '../services/trakt/client.js';
import { getAccessToken } from '../services/trakt/auth.js';
import { TmdbClient } from '../services/watching/tmdb.js';
import { requireAuth } from '../lib/auth.js';
import { backfillImages } from '../services/images/backfill.js';
import type { BackfillItem } from '../services/images/backfill.js';
import { runPipeline } from '../services/images/pipeline.js';
import type { SourceSearchParams } from '../services/images/sources/types.js';
import {
  getImageAttachment,
  getImageAttachmentBatch,
} from '../lib/images.js';

const collecting = new Hono<{ Bindings: Env }>();

// GET /collecting/collection - paginated, filterable, searchable
collecting.get('/collecting/collection', requireAuth('read'), async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(c.req.query('limit') || '20', 10))
    );
    const format = c.req.query('format');
    const genre = c.req.query('genre');
    const artist = c.req.query('artist');
    const sort = c.req.query('sort') || 'date_added';
    const order = c.req.query('order') || 'desc';
    const q = c.req.query('q');

    const db = createDb(c.env.DB);
    const offset = (page - 1) * limit;

    const conditions = [eq(discogsCollection.userId, 1)];

    if (format) {
      conditions.push(
        sql`json_extract(${discogsReleases.formats}, '$[0]') = ${format}`
      );
    }
    if (genre) {
      conditions.push(sql`${discogsReleases.genres} like ${`%${genre}%`}`);
    }
    if (q) {
      conditions.push(
        or(
          like(discogsReleases.title, `%${q}%`),
          sql`exists (
            select 1 from discogs_release_artists dra
            inner join discogs_artists da on dra.artist_id = da.id
            where dra.release_id = discogs_releases.id
            and da.name like ${`%${q}%`}
          )`
        )!
      );
    }
    if (artist) {
      conditions.push(
        sql`exists (
          select 1 from discogs_release_artists dra
          inner join discogs_artists da on dra.artist_id = da.id
          where dra.release_id = discogs_releases.id
          and da.name like ${`%${artist}%`}
        )`
      );
    }

    const whereClause = and(...conditions);

    // Count total
    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(discogsCollection)
      .innerJoin(
        discogsReleases,
        eq(discogsCollection.releaseId, discogsReleases.id)
      )
      .where(whereClause);

    // Determine sort column
    let orderBy;
    const direction = order === 'asc' ? asc : desc;
    switch (sort) {
      case 'title':
        orderBy = direction(discogsReleases.title);
        break;
      case 'year':
        orderBy = direction(discogsReleases.year);
        break;
      case 'rating':
        orderBy = direction(discogsCollection.rating);
        break;
      case 'date_added':
      default:
        orderBy = direction(discogsCollection.dateAdded);
        break;
    }

    const rows = await db
      .select({
        id: discogsCollection.id,
        discogsId: discogsReleases.discogsId,
        title: discogsReleases.title,
        year: discogsReleases.year,
        format: discogsReleases.formats,
        formatDetail: discogsReleases.formatDetails,
        label: discogsReleases.labels,
        genres: discogsReleases.genres,
        styles: discogsReleases.styles,
        coverUrl: discogsReleases.coverUrl,
        dateAdded: discogsCollection.dateAdded,
        rating: discogsCollection.rating,
        discogsUrl: discogsReleases.discogsUrl,
      })
      .from(discogsCollection)
      .innerJoin(
        discogsReleases,
        eq(discogsCollection.releaseId, discogsReleases.id)
      )
      .where(whereClause)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    // Get artists and image metadata for each release
    const releaseIds = rows.map((r) => String(r.discogsId));
    const imageMap = await getImageAttachmentBatch(
      db,
      'collecting',
      'releases',
      releaseIds
    );

    const data = await Promise.all(
      rows.map(async (row) => {
        const artistRows = await db
          .select({ name: discogsArtists.name })
          .from(discogsReleaseArtists)
          .innerJoin(
            discogsArtists,
            eq(discogsReleaseArtists.artistId, discogsArtists.id)
          )
          .innerJoin(
            discogsReleases,
            eq(discogsReleaseArtists.releaseId, discogsReleases.id)
          )
          .where(eq(discogsReleases.discogsId, row.discogsId));

        const formats: string[] = row.format ? JSON.parse(row.format) : [];
        return {
          id: row.id,
          discogs_id: row.discogsId,
          title: row.title,
          artists: artistRows.map((a) => a.name),
          year: row.year,
          format: formats[0] || 'Unknown',
          format_detail: row.formatDetail || '[]',
          label: row.label || '[]',
          genres: row.genres ? JSON.parse(row.genres) : [],
          styles: row.styles ? JSON.parse(row.styles) : [],
          image: imageMap.get(String(row.discogsId)) ?? null,
          date_added: row.dateAdded,
          rating: row.rating,
          discogs_url: row.discogsUrl,
        };
      })
    );

    setCache(c, 'long');
    return c.json({
      data,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/collection: ${err}`);
    return serverError(c);
  }
});

// GET /collecting/stats
collecting.get('/collecting/stats', requireAuth('read'), async (c) => {
  try {
    const db = createDb(c.env.DB);

    const [stats] = await db
      .select()
      .from(discogsCollectionStats)
      .where(eq(discogsCollectionStats.userId, 1));

    if (!stats) {
      return c.json({ data: {
        total_items: 0,
        by_format: { vinyl: 0, cd: 0, cassette: 0, other: 0 },
        wantlist_count: 0,
        unique_artists: 0,
        estimated_value: null,
        top_genre: null,
        oldest_release_year: null,
        newest_release_year: null,
        most_collected_artist: null,
        added_this_year: 0,
      } });
    }

    setCache(c, 'long');
    return c.json({ data: {
      total_items: stats.totalItems,
      by_format: stats.byFormat
        ? JSON.parse(stats.byFormat)
        : { vinyl: 0, cd: 0, cassette: 0, other: 0 },
      wantlist_count: stats.wantlistCount,
      unique_artists: stats.uniqueArtists,
      estimated_value: stats.estimatedValue,
      top_genre: stats.topGenre,
      oldest_release_year: stats.oldestReleaseYear,
      newest_release_year: stats.newestReleaseYear,
      most_collected_artist: stats.mostCollectedArtist
        ? JSON.parse(stats.mostCollectedArtist)
        : null,
      added_this_year: stats.addedThisYear,
    } });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/stats: ${err}`);
    return serverError(c);
  }
});

// GET /collecting/recent
collecting.get('/collecting/recent', requireAuth('read'), async (c) => {
  try {
    const limit = Math.min(
      20,
      Math.max(1, parseInt(c.req.query('limit') || '5', 10))
    );

    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        id: discogsCollection.id,
        discogsId: discogsReleases.discogsId,
        title: discogsReleases.title,
        year: discogsReleases.year,
        format: discogsReleases.formats,
        formatDetail: discogsReleases.formatDetails,
        label: discogsReleases.labels,
        genres: discogsReleases.genres,
        styles: discogsReleases.styles,
        coverUrl: discogsReleases.coverUrl,
        dateAdded: discogsCollection.dateAdded,
        rating: discogsCollection.rating,
        discogsUrl: discogsReleases.discogsUrl,
      })
      .from(discogsCollection)
      .innerJoin(
        discogsReleases,
        eq(discogsCollection.releaseId, discogsReleases.id)
      )
      .where(eq(discogsCollection.userId, 1))
      .orderBy(desc(discogsCollection.dateAdded))
      .limit(limit);

    const releaseIds = rows.map((r) => String(r.discogsId));
    const imageMap = await getImageAttachmentBatch(
      db,
      'collecting',
      'releases',
      releaseIds
    );

    const data = await Promise.all(
      rows.map(async (row) => {
        const artistRows = await db
          .select({ name: discogsArtists.name })
          .from(discogsReleaseArtists)
          .innerJoin(
            discogsArtists,
            eq(discogsReleaseArtists.artistId, discogsArtists.id)
          )
          .innerJoin(
            discogsReleases,
            eq(discogsReleaseArtists.releaseId, discogsReleases.id)
          )
          .where(eq(discogsReleases.discogsId, row.discogsId));

        const formats: string[] = row.format ? JSON.parse(row.format) : [];
        return {
          id: row.id,
          discogs_id: row.discogsId,
          title: row.title,
          artists: artistRows.map((a) => a.name),
          year: row.year,
          format: formats[0] || 'Unknown',
          format_detail: row.formatDetail || '[]',
          label: row.label || '[]',
          genres: row.genres ? JSON.parse(row.genres) : [],
          styles: row.styles ? JSON.parse(row.styles) : [],
          image: imageMap.get(String(row.discogsId)) ?? null,
          date_added: row.dateAdded,
          rating: row.rating,
          discogs_url: row.discogsUrl,
        };
      })
    );

    setCache(c, 'medium');
    return c.json({ data });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/recent: ${err}`);
    return serverError(c);
  }
});

// GET /collecting/collection/:id
collecting.get('/collecting/collection/:id', requireAuth('read'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return badRequest(c, 'Invalid collection item ID');
    }

    const db = createDb(c.env.DB);

    const [row] = await db
      .select({
        id: discogsCollection.id,
        discogsId: discogsReleases.discogsId,
        title: discogsReleases.title,
        year: discogsReleases.year,
        format: discogsReleases.formats,
        formatDetail: discogsReleases.formatDetails,
        label: discogsReleases.labels,
        genres: discogsReleases.genres,
        styles: discogsReleases.styles,
        coverUrl: discogsReleases.coverUrl,
        dateAdded: discogsCollection.dateAdded,
        rating: discogsCollection.rating,
        discogsUrl: discogsReleases.discogsUrl,
        tracklist: discogsReleases.tracklist,
        country: discogsReleases.country,
        communityHave: discogsReleases.communityHave,
        communityWant: discogsReleases.communityWant,
        lowestPrice: discogsReleases.lowestPrice,
        numForSale: discogsReleases.numForSale,
        notes: discogsCollection.notes,
      })
      .from(discogsCollection)
      .innerJoin(
        discogsReleases,
        eq(discogsCollection.releaseId, discogsReleases.id)
      )
      .where(
        and(eq(discogsCollection.id, id), eq(discogsCollection.userId, 1))
      );

    if (!row) {
      return notFound(c, 'Collection item not found');
    }

    const artistRows = await db
      .select({ name: discogsArtists.name })
      .from(discogsReleaseArtists)
      .innerJoin(
        discogsArtists,
        eq(discogsReleaseArtists.artistId, discogsArtists.id)
      )
      .innerJoin(
        discogsReleases,
        eq(discogsReleaseArtists.releaseId, discogsReleases.id)
      )
      .where(eq(discogsReleases.discogsId, row.discogsId));

    const formats: string[] = row.format ? JSON.parse(row.format) : [];
    const image = await getImageAttachment(
      db,
      'collecting',
      'releases',
      String(row.discogsId)
    );

    setCache(c, 'long');
    return c.json({
      id: row.id,
      discogs_id: row.discogsId,
      title: row.title,
      artists: artistRows.map((a) => a.name),
      year: row.year,
      format: formats[0] || 'Unknown',
      format_detail: row.formatDetail || '[]',
      label: row.label || '[]',
      genres: row.genres ? JSON.parse(row.genres) : [],
      styles: row.styles ? JSON.parse(row.styles) : [],
      image,
      date_added: row.dateAdded,
      rating: row.rating,
      discogs_url: row.discogsUrl,
      tracklist: row.tracklist ? JSON.parse(row.tracklist) : [],
      country: row.country,
      community_have: row.communityHave,
      community_want: row.communityWant,
      lowest_price: row.lowestPrice,
      num_for_sale: row.numForSale,
      notes: row.notes ? JSON.parse(row.notes) : null,
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/collection/:id: ${err}`);
    return serverError(c);
  }
});

// GET /collecting/wantlist
collecting.get('/collecting/wantlist', requireAuth('read'), async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(c.req.query('limit') || '20', 10))
    );
    const sort = c.req.query('sort') || 'date_added';
    const order = c.req.query('order') || 'desc';

    const db = createDb(c.env.DB);
    const offset = (page - 1) * limit;

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(discogsWantlist)
      .where(eq(discogsWantlist.userId, 1));

    const direction = order === 'asc' ? asc : desc;
    let orderBy;
    switch (sort) {
      case 'title':
        orderBy = direction(discogsWantlist.title);
        break;
      case 'year':
        orderBy = direction(discogsWantlist.year);
        break;
      case 'date_added':
      default:
        orderBy = direction(discogsWantlist.dateAdded);
        break;
    }

    const rows = await db
      .select()
      .from(discogsWantlist)
      .where(eq(discogsWantlist.userId, 1))
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    const data = rows.map((row) => ({
      id: row.id,
      discogs_id: row.discogsId,
      title: row.title,
      artists: row.artists ? JSON.parse(row.artists) : [],
      year: row.year,
      formats: row.formats ? JSON.parse(row.formats) : [],
      genres: row.genres ? JSON.parse(row.genres) : [],
      image: null as null,
      discogs_url: row.discogsUrl,
      notes: row.notes,
      rating: row.rating,
      date_added: row.dateAdded,
    }));

    setCache(c, 'long');
    return c.json({
      data,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/wantlist: ${err}`);
    return serverError(c);
  }
});

// GET /collecting/formats
collecting.get('/collecting/formats', requireAuth('read'), async (c) => {
  try {
    const db = createDb(c.env.DB);

    const rows = await db
      .select({ formats: discogsReleases.formats })
      .from(discogsCollection)
      .innerJoin(
        discogsReleases,
        eq(discogsCollection.releaseId, discogsReleases.id)
      )
      .where(eq(discogsCollection.userId, 1));

    const formatCounts: Record<string, number> = {};
    for (const row of rows) {
      const formats: string[] = row.formats ? JSON.parse(row.formats) : [];
      const primaryFormat = formats[0] || 'Unknown';
      formatCounts[primaryFormat] = (formatCounts[primaryFormat] || 0) + 1;
    }

    const data = Object.entries(formatCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    setCache(c, 'long');
    return c.json({ data });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/formats: ${err}`);
    return serverError(c);
  }
});

// GET /collecting/genres
collecting.get('/collecting/genres', requireAuth('read'), async (c) => {
  try {
    const db = createDb(c.env.DB);

    const rows = await db
      .select({ genres: discogsReleases.genres })
      .from(discogsCollection)
      .innerJoin(
        discogsReleases,
        eq(discogsCollection.releaseId, discogsReleases.id)
      )
      .where(eq(discogsCollection.userId, 1));

    const genreCounts: Record<string, number> = {};
    for (const row of rows) {
      const genres: string[] = row.genres ? JSON.parse(row.genres) : [];
      for (const genre of genres) {
        genreCounts[genre] = (genreCounts[genre] || 0) + 1;
      }
    }

    const data = Object.entries(genreCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    setCache(c, 'long');
    return c.json({ data });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/genres: ${err}`);
    return serverError(c);
  }
});

// GET /collecting/artists
collecting.get('/collecting/artists', requireAuth('read'), async (c) => {
  try {
    const limit = Math.min(
      100,
      Math.max(1, parseInt(c.req.query('limit') || '20', 10))
    );

    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        name: discogsArtists.name,
        discogsId: discogsArtists.discogsId,
        imageUrl: discogsArtists.imageUrl,
        count: sql<number>`count(*)`,
      })
      .from(discogsReleaseArtists)
      .innerJoin(
        discogsArtists,
        eq(discogsReleaseArtists.artistId, discogsArtists.id)
      )
      .innerJoin(
        discogsCollection,
        eq(discogsReleaseArtists.releaseId, discogsCollection.releaseId)
      )
      .where(eq(discogsCollection.userId, 1))
      .groupBy(discogsArtists.id)
      .orderBy(sql`count(*) desc`)
      .limit(limit);

    const data = rows.map((row) => ({
      name: row.name,
      discogs_id: row.discogsId,
      image_url: row.imageUrl,
      release_count: row.count,
    }));

    setCache(c, 'long');
    return c.json({ data });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/artists: ${err}`);
    return serverError(c);
  }
});

// GET /collecting/cross-reference
collecting.get(
  '/collecting/cross-reference',
  requireAuth('read'),
  async (c) => {
    try {
      const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
      const limit = Math.min(
        100,
        Math.max(1, parseInt(c.req.query('limit') || '20', 10))
      );
      const sort = c.req.query('sort') || 'plays';
      const filter = c.req.query('filter') || 'all';

      const db = createDb(c.env.DB);
      const offset = (page - 1) * limit;

      const conditions = [eq(collectionListeningXref.userId, 1)];

      if (filter === 'listened') {
        conditions.push(sql`${collectionListeningXref.playCount} > 0`);
      } else if (filter === 'unlistened') {
        conditions.push(
          or(
            eq(collectionListeningXref.playCount, 0),
            eq(collectionListeningXref.matchType, 'none')
          )!
        );
      }

      const whereClause = and(...conditions);

      const [{ count: total }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(collectionListeningXref)
        .where(whereClause);

      const orderBy =
        sort === 'added'
          ? desc(discogsCollection.dateAdded)
          : desc(collectionListeningXref.playCount);

      const rows = await db
        .select({
          xrefId: collectionListeningXref.id,
          collectionId: collectionListeningXref.collectionId,
          releaseId: collectionListeningXref.releaseId,
          lastfmAlbumName: collectionListeningXref.lastfmAlbumName,
          lastfmArtistName: collectionListeningXref.lastfmArtistName,
          playCount: collectionListeningXref.playCount,
          lastPlayed: collectionListeningXref.lastPlayed,
          matchType: collectionListeningXref.matchType,
          matchConfidence: collectionListeningXref.matchConfidence,
          // Collection item fields
          itemId: discogsCollection.id,
          dateAdded: discogsCollection.dateAdded,
          rating: discogsCollection.rating,
          // Release fields
          discogsId: discogsReleases.discogsId,
          title: discogsReleases.title,
          year: discogsReleases.year,
          formats: discogsReleases.formats,
          genres: discogsReleases.genres,
          styles: discogsReleases.styles,
          coverUrl: discogsReleases.coverUrl,
          discogsUrl: discogsReleases.discogsUrl,
        })
        .from(collectionListeningXref)
        .innerJoin(
          discogsCollection,
          eq(collectionListeningXref.collectionId, discogsCollection.id)
        )
        .innerJoin(
          discogsReleases,
          eq(collectionListeningXref.releaseId, discogsReleases.id)
        )
        .where(whereClause)
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset);

      const releaseIds = rows.map((r) => String(r.discogsId));
      const imageMap = await getImageAttachmentBatch(
        db,
        'collecting',
        'releases',
        releaseIds
      );

      const data = await Promise.all(
        rows.map(async (row) => {
          const artistRows = await db
            .select({ name: discogsArtists.name })
            .from(discogsReleaseArtists)
            .innerJoin(
              discogsArtists,
              eq(discogsReleaseArtists.artistId, discogsArtists.id)
            )
            .innerJoin(
              discogsReleases,
              eq(discogsReleaseArtists.releaseId, discogsReleases.id)
            )
            .where(eq(discogsReleases.discogsId, row.discogsId));

          const formats: string[] = row.formats ? JSON.parse(row.formats) : [];

          return {
            collection: {
              id: row.itemId,
              discogs_id: row.discogsId,
              title: row.title,
              artists: artistRows.map((a) => a.name),
              year: row.year,
              format: formats[0] || 'Unknown',
              genres: row.genres ? JSON.parse(row.genres) : [],
              styles: row.styles ? JSON.parse(row.styles) : [],
              image: imageMap.get(String(row.discogsId)) ?? null,
              date_added: row.dateAdded,
              rating: row.rating,
              discogs_url: row.discogsUrl,
            },
            listening: {
              album_name: row.lastfmAlbumName,
              artist_name: row.lastfmArtistName,
              play_count: row.playCount,
              last_played: row.lastPlayed,
              match_type: row.matchType,
              match_confidence: row.matchConfidence,
            },
          };
        })
      );

      // Summary stats
      const [{ totalMatches }] = await db
        .select({
          totalMatches: sql<number>`count(case when ${collectionListeningXref.matchType} != 'none' then 1 end)`,
        })
        .from(collectionListeningXref)
        .where(eq(collectionListeningXref.userId, 1));

      const [{ totalAll }] = await db
        .select({ totalAll: sql<number>`count(*)` })
        .from(collectionListeningXref)
        .where(eq(collectionListeningXref.userId, 1));

      const [{ unlistenedCount }] = await db
        .select({
          unlistenedCount: sql<number>`count(case when ${collectionListeningXref.playCount} = 0 or ${collectionListeningXref.matchType} = 'none' then 1 end)`,
        })
        .from(collectionListeningXref)
        .where(eq(collectionListeningXref.userId, 1));

      setCache(c, 'long');
      return c.json({
        data,
        summary: {
          total_matches: totalMatches,
          listen_rate: totalAll > 0 ? totalMatches / totalAll : 0,
          unlistened_count: unlistenedCount,
        },
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      console.log(`[ERROR] GET /collecting/cross-reference: ${err}`);
      return serverError(c);
    }
  }
);

// POST /admin/sync/collecting -- moved to admin-sync.ts
// Legacy path redirects to /v1/admin/sync/collecting

// POST /admin/collecting/backfill-images
collecting.post(
  '/admin/collecting/backfill-images',
  requireAuth('admin'),
  async (c) => {
    try {
      const db = createDb(c.env.DB);
      const body = await c.req
        .json<{ limit?: number }>()
        .catch(() => ({ limit: undefined }));
      const maxItems = Math.min(body.limit || 50, 200);

      // Get releases without images, joined with primary artist name
      const rows = await db
        .select({
          discogsId: discogsReleases.discogsId,
          title: discogsReleases.title,
        })
        .from(discogsReleases)
        .where(
          sql`${discogsReleases.discogsId} NOT IN (
          SELECT ${images.entityId} FROM ${images}
          WHERE ${images.domain} = 'collecting' AND ${images.entityType} = 'releases'
        )`
        )
        .limit(maxItems);

      // Get artist names for each release
      const items: BackfillItem[] = await Promise.all(
        rows.map(async (row) => {
          const [artist] = await db
            .select({ name: discogsArtists.name })
            .from(discogsReleaseArtists)
            .innerJoin(
              discogsArtists,
              eq(discogsReleaseArtists.artistId, discogsArtists.id)
            )
            .innerJoin(
              discogsReleases,
              eq(discogsReleaseArtists.releaseId, discogsReleases.id)
            )
            .where(eq(discogsReleases.discogsId, row.discogsId))
            .limit(1);

          return {
            entityId: String(row.discogsId),
            artistName: artist?.name,
            albumName: row.title,
          };
        })
      );

      const result = await backfillImages(
        db,
        c.env,
        'collecting',
        'releases',
        items,
        { batchSize: 5, delayMs: 500 }
      );

      return c.json({ success: true, results: result });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log(
        `[ERROR] POST /admin/collecting/backfill-images: ${errorMsg}`
      );
      return serverError(c, `Backfill failed: ${errorMsg}`);
    }
  }
);

// ─── Physical Media (Trakt) Routes ───────────────────────────────────

// GET /collecting/media - paginated physical media collection
collecting.get('/collecting/media', requireAuth('read'), async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(c.req.query('limit') || '20', 10))
    );
    const format = c.req.query('format');
    const genre = c.req.query('genre');
    const sort = c.req.query('sort') || 'collected_at';
    const order = c.req.query('order') || 'desc';
    const q = c.req.query('q');

    const db = createDb(c.env.DB);
    const offset = (page - 1) * limit;

    const conditions = [eq(traktCollection.userId, 1)];

    if (format) {
      conditions.push(
        sql`${traktCollection.mediaType} = ${format}`
      );
    }
    if (genre) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM movie_genres mg
          JOIN genres g ON mg.genre_id = g.id
          WHERE mg.movie_id = ${movies.id}
          AND g.name LIKE ${`%${genre}%`}
        )`
      );
    }
    if (q) {
      conditions.push(like(movies.title, `%${q}%`));
    }

    const whereClause = and(...conditions);

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(traktCollection)
      .innerJoin(movies, eq(traktCollection.movieId, movies.id))
      .where(whereClause);

    const direction = order === 'asc' ? asc : desc;
    let orderBy;
    switch (sort) {
      case 'title':
        orderBy = direction(movies.title);
        break;
      case 'year':
        orderBy = direction(movies.year);
        break;
      case 'collected_at':
      default:
        orderBy = direction(traktCollection.collectedAt);
        break;
    }

    const rows = await db
      .select({
        id: traktCollection.id,
        movieId: traktCollection.movieId,
        traktId: traktCollection.traktId,
        mediaType: traktCollection.mediaType,
        resolution: traktCollection.resolution,
        hdr: traktCollection.hdr,
        audio: traktCollection.audio,
        audioChannels: traktCollection.audioChannels,
        collectedAt: traktCollection.collectedAt,
        title: movies.title,
        year: movies.year,
        tmdbId: movies.tmdbId,
        imdbId: movies.imdbId,
        posterPath: movies.posterPath,
        runtime: movies.runtime,
        tmdbRating: movies.tmdbRating,
      })
      .from(traktCollection)
      .innerJoin(movies, eq(traktCollection.movieId, movies.id))
      .where(whereClause)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    const movieIds = rows.map((r) => String(r.movieId));
    const imageMap = await getImageAttachmentBatch(
      db,
      'watching',
      'movies',
      movieIds
    );

    const data = rows.map((row) => ({
      id: row.id,
      title: row.title,
      year: row.year,
      tmdb_id: row.tmdbId,
      imdb_id: row.imdbId,
      image: imageMap.get(String(row.movieId)) ?? null,
      runtime: row.runtime,
      tmdb_rating: row.tmdbRating,
      media_type: row.mediaType,
      resolution: row.resolution,
      hdr: row.hdr,
      audio: row.audio,
      audio_channels: row.audioChannels,
      collected_at: row.collectedAt,
    }));

    setCache(c, 'long');
    return c.json({
      data,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/media: ${err}`);
    return serverError(c);
  }
});

// GET /collecting/media/stats - physical media stats
collecting.get('/collecting/media/stats', requireAuth('read'), async (c) => {
  try {
    const db = createDb(c.env.DB);

    const [stats] = await db
      .select()
      .from(traktCollectionStats)
      .where(eq(traktCollectionStats.userId, 1));

    if (!stats) {
      return c.json({ data: {
        total_items: 0,
        by_format: {},
        by_resolution: {},
        by_hdr: {},
        by_genre: {},
        by_decade: {},
        added_this_year: 0,
      } });
    }

    setCache(c, 'long');
    return c.json({ data: {
      total_items: stats.totalItems,
      by_format: stats.byFormat ? JSON.parse(stats.byFormat) : {},
      by_resolution: stats.byResolution ? JSON.parse(stats.byResolution) : {},
      by_hdr: stats.byHdr ? JSON.parse(stats.byHdr) : {},
      by_genre: stats.byGenre ? JSON.parse(stats.byGenre) : {},
      by_decade: stats.byDecade ? JSON.parse(stats.byDecade) : {},
      added_this_year: stats.addedThisYear,
    } });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/media/stats: ${err}`);
    return serverError(c);
  }
});

// GET /collecting/media/recent - recently added physical media
collecting.get('/collecting/media/recent', requireAuth('read'), async (c) => {
  try {
    const limit = Math.min(
      20,
      Math.max(1, parseInt(c.req.query('limit') || '5', 10))
    );
    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        id: traktCollection.id,
        movieId: traktCollection.movieId,
        mediaType: traktCollection.mediaType,
        resolution: traktCollection.resolution,
        hdr: traktCollection.hdr,
        audio: traktCollection.audio,
        audioChannels: traktCollection.audioChannels,
        collectedAt: traktCollection.collectedAt,
        title: movies.title,
        year: movies.year,
        tmdbId: movies.tmdbId,
        posterPath: movies.posterPath,
        tmdbRating: movies.tmdbRating,
      })
      .from(traktCollection)
      .innerJoin(movies, eq(traktCollection.movieId, movies.id))
      .where(eq(traktCollection.userId, 1))
      .orderBy(desc(traktCollection.collectedAt))
      .limit(limit);

    const movieIds = rows.map((r) => String(r.movieId));
    const imageMap = await getImageAttachmentBatch(
      db,
      'watching',
      'movies',
      movieIds
    );

    const data = rows.map((row) => ({
      id: row.id,
      title: row.title,
      year: row.year,
      tmdb_id: row.tmdbId,
      image: imageMap.get(String(row.movieId)) ?? null,
      tmdb_rating: row.tmdbRating,
      media_type: row.mediaType,
      resolution: row.resolution,
      hdr: row.hdr,
      audio: row.audio,
      audio_channels: row.audioChannels,
      collected_at: row.collectedAt,
    }));

    setCache(c, 'medium');
    return c.json({ data });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/media/recent: ${err}`);
    return serverError(c);
  }
});

// GET /collecting/media/formats - format breakdown counts
collecting.get('/collecting/media/formats', requireAuth('read'), async (c) => {
  try {
    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        mediaType: traktCollection.mediaType,
        count: sql<number>`count(*)`,
      })
      .from(traktCollection)
      .where(eq(traktCollection.userId, 1))
      .groupBy(traktCollection.mediaType)
      .orderBy(sql`count(*) desc`);

    const data = rows.map((row) => ({
      name: row.mediaType,
      count: row.count,
    }));

    setCache(c, 'long');
    return c.json({ data });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/media/formats: ${err}`);
    return serverError(c);
  }
});

// GET /collecting/media/cross-reference - owned vs watched
collecting.get(
  '/collecting/media/cross-reference',
  requireAuth('read'),
  async (c) => {
    try {
      const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
      const limit = Math.min(
        100,
        Math.max(1, parseInt(c.req.query('limit') || '20', 10))
      );
      const filter = c.req.query('filter') || 'all';

      const db = createDb(c.env.DB);
      const offset = (page - 1) * limit;

      // Base query: trakt_collection joined with movies and optional watch_history
      const baseConditions = [eq(traktCollection.userId, 1)];

      if (filter === 'watched') {
        baseConditions.push(
          sql`EXISTS (
            SELECT 1 FROM watch_history wh
            WHERE wh.movie_id = ${traktCollection.movieId}
          )`
        );
      } else if (filter === 'unwatched') {
        baseConditions.push(
          sql`NOT EXISTS (
            SELECT 1 FROM watch_history wh
            WHERE wh.movie_id = ${traktCollection.movieId}
          )`
        );
      }

      const whereClause = and(...baseConditions);

      const [{ count: total }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(traktCollection)
        .innerJoin(movies, eq(traktCollection.movieId, movies.id))
        .where(whereClause);

      const rows = await db
        .select({
          id: traktCollection.id,
          movieId: traktCollection.movieId,
          mediaType: traktCollection.mediaType,
          resolution: traktCollection.resolution,
          collectedAt: traktCollection.collectedAt,
          title: movies.title,
          year: movies.year,
          tmdbId: movies.tmdbId,
          posterPath: movies.posterPath,
        })
        .from(traktCollection)
        .innerJoin(movies, eq(traktCollection.movieId, movies.id))
        .where(whereClause)
        .orderBy(desc(traktCollection.collectedAt))
        .limit(limit)
        .offset(offset);

      // Get watch counts for each movie
      const movieIds = rows.map((r) => r.movieId);
      const watchCounts = new Map<number, { count: number; lastWatched: string | null }>();

      if (movieIds.length > 0) {
        const watchRows = await db
          .select({
            movieId: watchHistory.movieId,
            count: sql<number>`count(*)`,
            lastWatched: sql<string | null>`max(${watchHistory.watchedAt})`,
          })
          .from(watchHistory)
          .where(inArray(watchHistory.movieId, movieIds))
          .groupBy(watchHistory.movieId);

        for (const wr of watchRows) {
          watchCounts.set(wr.movieId, {
            count: wr.count,
            lastWatched: wr.lastWatched,
          });
        }
      }

      const data = rows.map((row) => {
        const watch = watchCounts.get(row.movieId);
        return {
          collection: {
            id: row.id,
            title: row.title,
            year: row.year,
            tmdb_id: row.tmdbId,
            image: null as null,
            media_type: row.mediaType,
            resolution: row.resolution,
            collected_at: row.collectedAt,
          },
          watching: {
            watched: !!watch,
            watch_count: watch?.count || 0,
            last_watched: watch?.lastWatched || null,
          },
        };
      });

      // Summary
      const [{ totalOwned }] = await db
        .select({ totalOwned: sql<number>`count(*)` })
        .from(traktCollection)
        .where(eq(traktCollection.userId, 1));

      const [{ totalWatched }] = await db
        .select({
          totalWatched: sql<number>`count(distinct ${traktCollection.movieId})`,
        })
        .from(traktCollection)
        .innerJoin(
          watchHistory,
          eq(traktCollection.movieId, watchHistory.movieId)
        )
        .where(eq(traktCollection.userId, 1));

      setCache(c, 'long');
      return c.json({
        data,
        summary: {
          total_owned: totalOwned,
          total_watched: totalWatched,
          total_unwatched: totalOwned - totalWatched,
          watch_rate: totalOwned > 0 ? totalWatched / totalOwned : 0,
        },
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      console.log(`[ERROR] GET /collecting/media/cross-reference: ${err}`);
      return serverError(c);
    }
  }
);

// GET /collecting/media/:id - single physical media item detail
collecting.get('/collecting/media/:id', requireAuth('read'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return badRequest(c, 'Invalid media item ID');
    }

    const db = createDb(c.env.DB);

    const [row] = await db
      .select({
        id: traktCollection.id,
        movieId: traktCollection.movieId,
        traktId: traktCollection.traktId,
        mediaType: traktCollection.mediaType,
        resolution: traktCollection.resolution,
        hdr: traktCollection.hdr,
        audio: traktCollection.audio,
        audioChannels: traktCollection.audioChannels,
        collectedAt: traktCollection.collectedAt,
        title: movies.title,
        year: movies.year,
        tmdbId: movies.tmdbId,
        imdbId: movies.imdbId,
        tagline: movies.tagline,
        summary: movies.summary,
        posterPath: movies.posterPath,
        backdropPath: movies.backdropPath,
        runtime: movies.runtime,
        tmdbRating: movies.tmdbRating,
        contentRating: movies.contentRating,
      })
      .from(traktCollection)
      .innerJoin(movies, eq(traktCollection.movieId, movies.id))
      .where(
        and(eq(traktCollection.id, id), eq(traktCollection.userId, 1))
      );

    if (!row) {
      return notFound(c, 'Media item not found');
    }

    // Get watch history for this movie
    const watchRows = await db
      .select({
        watchedAt: watchHistory.watchedAt,
        source: watchHistory.source,
        userRating: watchHistory.userRating,
      })
      .from(watchHistory)
      .where(eq(watchHistory.movieId, row.movieId))
      .orderBy(desc(watchHistory.watchedAt));

    const image = row.movieId
      ? await getImageAttachment(db, 'watching', 'movies', String(row.movieId))
      : null;

    setCache(c, 'long');
    return c.json({
      id: row.id,
      title: row.title,
      year: row.year,
      tmdb_id: row.tmdbId,
      imdb_id: row.imdbId,
      tagline: row.tagline,
      summary: row.summary,
      image,
      runtime: row.runtime,
      tmdb_rating: row.tmdbRating,
      content_rating: row.contentRating,
      media_type: row.mediaType,
      resolution: row.resolution,
      hdr: row.hdr,
      audio: row.audio,
      audio_channels: row.audioChannels,
      collected_at: row.collectedAt,
      watch_history: watchRows.map((w) => ({
        watched_at: w.watchedAt,
        source: w.source,
        user_rating: w.userRating,
      })),
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/media/:id: ${err}`);
    return serverError(c);
  }
});

// POST /admin/collecting/media - add physical media to collection
collecting.post('/admin/collecting/media', requireAuth('admin'), async (c) => {
  try {
    const body = await c.req.json<{
      tmdb_id?: number;
      imdb_id?: string;
      title?: string;
      year?: number;
      media_type: string;
      resolution?: string;
      hdr?: string;
      audio?: string;
      audio_channels?: string;
    }>();

    if (!body.media_type) {
      return badRequest(c, 'media_type is required');
    }

    const db = createDb(c.env.DB);
    const tmdbClient = new TmdbClient(c.env.TMDB_API_KEY);

    // Resolve TMDb ID
    let tmdbId: number | null = body.tmdb_id || null;

    if (!tmdbId && body.imdb_id) {
      tmdbId = await tmdbClient.findByImdbId(body.imdb_id);
    }

    if (!tmdbId && body.title) {
      const results = await tmdbClient.searchMovie(body.title, body.year);
      if (results.length === 0) {
        return notFound(c, `No movie found for "${body.title}"`);
      }
      if (results.length > 1 && !body.year) {
        return c.json({
          status: 'ambiguous',
          message: 'Multiple results found. Specify year or tmdb_id.',
          candidates: results.slice(0, 5).map((r) => ({
            tmdb_id: r.id,
            title: r.title,
            release_date: r.release_date,
          })),
        }, 422);
      }
      tmdbId = results[0].id;
    }

    if (!tmdbId) {
      return badRequest(c, 'Provide tmdb_id, imdb_id, or title to identify the movie');
    }

    // Get movie detail from TMDb
    const detail = await tmdbClient.getMovieDetail(tmdbId);

    // Ensure movie exists locally
    const [existing] = await db
      .select({ id: movies.id })
      .from(movies)
      .where(eq(movies.tmdbId, tmdbId))
      .limit(1);

    let movieId: number;
    if (existing) {
      movieId = existing.id;
    } else {
      const [inserted] = await db
        .insert(movies)
        .values({
          title: detail.title,
          year: detail.year,
          tmdbId,
          imdbId: detail.imdb_id,
          tagline: detail.tagline,
          summary: detail.overview,
          runtime: detail.runtime,
          tmdbRating: detail.vote_average,
          posterPath: detail.poster_path,
          backdropPath: detail.backdrop_path,
          contentRating: detail.content_rating,
        })
        .returning({ id: movies.id });
      movieId = inserted.id;
    }

    // Push to Trakt
    const accessToken = await getAccessToken(c.env, db);
    const traktClient = new TraktClient(accessToken, c.env.TRAKT_CLIENT_ID);

    // Map local uhd_bluray to Trakt's bluray + uhd_4k resolution
    const traktMediaType = body.media_type === 'uhd_bluray' ? 'bluray' : body.media_type;
    const traktResolution = body.media_type === 'uhd_bluray'
      ? (body.resolution || 'uhd_4k')
      : body.resolution;

    const traktResult = await traktClient.addToCollection([
      {
        ids: { tmdb: tmdbId },
        media_type: traktMediaType,
        resolution: traktResolution,
        hdr: body.hdr,
        audio: body.audio,
        audio_channels: body.audio_channels,
      },
    ]);

    // Sync back from Trakt to get the trakt_id
    // (The add response doesn't return the trakt ID directly)
    const collection = await traktClient.getCollection();
    const traktItem = collection.find(
      (item) => item.movie.ids.tmdb === tmdbId
    );

    const traktId = traktItem?.movie.ids.trakt || 0;

    // Store locally
    await db
      .insert(traktCollection)
      .values({
        movieId,
        traktId,
        mediaType: body.media_type as typeof traktCollection.$inferInsert.mediaType,
        resolution: (body.resolution || null) as typeof traktCollection.$inferInsert.resolution,
        hdr: (body.hdr || null) as typeof traktCollection.$inferInsert.hdr,
        audio: (body.audio || null) as typeof traktCollection.$inferInsert.audio,
        audioChannels: (body.audio_channels || null) as typeof traktCollection.$inferInsert.audioChannels,
        collectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [
          traktCollection.userId,
          traktCollection.traktId,
          traktCollection.mediaType,
        ],
        set: {
          resolution: sql`excluded.resolution`,
          hdr: sql`excluded.hdr`,
          audio: sql`excluded.audio`,
          audioChannels: sql`excluded.audio_channels`,
          updatedAt: sql`excluded.updated_at`,
        },
      });

    // Process image inline (poster via TMDb)
    let imageProcessed = false;
    try {
      const imageParams: SourceSearchParams = {
        domain: 'watching',
        entityType: 'movies',
        entityId: String(movieId),
        tmdbId: String(tmdbId),
      };
      const imageResult = await runPipeline(db, c.env, imageParams);
      imageProcessed = !!imageResult;
    } catch (imgErr) {
      console.log(
        `[ERROR] Image pipeline failed for movie ${tmdbId}: ${imgErr instanceof Error ? imgErr.message : String(imgErr)}`
      );
    }

    return c.json({
      status: 'ok',
      movie: {
        title: detail.title,
        year: detail.year,
        tmdb_id: tmdbId,
      },
      media_type: body.media_type,
      trakt: {
        added: traktResult.added.movies,
        existing: traktResult.existing.movies,
      },
      image_processed: imageProcessed,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] POST /admin/collecting/media: ${errorMsg}`);
    return serverError(c, `Failed to add media: ${errorMsg}`);
  }
});

// POST /admin/collecting/media/:id/remove - remove from collection
collecting.post(
  '/admin/collecting/media/:id/remove',
  requireAuth('admin'),
  async (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10);
      if (isNaN(id)) {
        return badRequest(c, 'Invalid media item ID');
      }

      const db = createDb(c.env.DB);

      const [item] = await db
        .select({
          id: traktCollection.id,
          traktId: traktCollection.traktId,
          mediaType: traktCollection.mediaType,
          tmdbId: movies.tmdbId,
          title: movies.title,
        })
        .from(traktCollection)
        .innerJoin(movies, eq(traktCollection.movieId, movies.id))
        .where(
          and(eq(traktCollection.id, id), eq(traktCollection.userId, 1))
        );

      if (!item) {
        return notFound(c, 'Media item not found');
      }

      // Remove from Trakt
      const accessToken = await getAccessToken(c.env, db);
      const traktClient = new TraktClient(accessToken, c.env.TRAKT_CLIENT_ID);

      await traktClient.removeFromCollection([
        {
          ids: { tmdb: item.tmdbId || undefined, trakt: item.traktId },
          media_type: item.mediaType,
        },
      ]);

      // Remove locally
      await db
        .delete(traktCollection)
        .where(eq(traktCollection.id, id));

      return c.json({
        status: 'ok',
        message: `Removed "${item.title}" (${item.mediaType}) from collection`,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log(`[ERROR] POST /admin/collecting/media/:id/remove: ${errorMsg}`);
      return serverError(c, `Failed to remove media: ${errorMsg}`);
    }
  }
);

// POST /admin/sync/trakt -- moved to admin-sync.ts
// Legacy path redirects to /v1/admin/sync/trakt

// POST /admin/collecting/media/backfill-images - backfill poster images
collecting.post(
  '/admin/collecting/media/backfill-images',
  requireAuth('admin'),
  async (c) => {
    try {
      const db = createDb(c.env.DB);
      const body = await c.req
        .json<{ limit?: number }>()
        .catch(() => ({ limit: undefined }));
      const maxItems = Math.min(body.limit || 50, 200);

      // Get movies in Trakt collection without images
      const rows = await db
        .select({
          tmdbId: movies.tmdbId,
          title: movies.title,
        })
        .from(traktCollection)
        .innerJoin(movies, eq(traktCollection.movieId, movies.id))
        .where(
          and(
            eq(traktCollection.userId, 1),
            sql`CAST(${movies.tmdbId} AS TEXT) NOT IN (
              SELECT ${images.entityId} FROM ${images}
              WHERE ${images.domain} = 'watching' AND ${images.entityType} = 'movies'
            )`
          )
        )
        .limit(maxItems);

      const items: BackfillItem[] = rows
        .filter((r) => r.tmdbId !== null)
        .map((row) => ({
          entityId: String(row.tmdbId),
          albumName: row.title,
        }));

      const result = await backfillImages(
        db,
        c.env,
        'watching',
        'movies',
        items,
        { batchSize: 5, delayMs: 500 }
      );

      return c.json({ success: true, results: result });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log(
        `[ERROR] POST /admin/collecting/media/backfill-images: ${errorMsg}`
      );
      return serverError(c, `Backfill failed: ${errorMsg}`);
    }
  }
);

export default collecting;
