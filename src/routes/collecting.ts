import { Hono } from 'hono';
import { eq, and, sql, desc, asc, like, or } from 'drizzle-orm';
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
import { setCache } from '../lib/cache.js';
import { notFound, badRequest, serverError } from '../lib/errors.js';
import { syncCollecting } from '../services/discogs/sync.js';
import { requireAuth } from '../lib/auth.js';

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

    // Get artists for each release
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
          cover_url: row.coverUrl,
          thumbhash: null,
          dominant_color: null,
          accent_color: null,
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
      return c.json({
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
      });
    }

    setCache(c, 'long');
    return c.json({
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
    });
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
          cover_url: row.coverUrl,
          thumbhash: null,
          dominant_color: null,
          accent_color: null,
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
      cover_url: row.coverUrl,
      thumbhash: null,
      dominant_color: null,
      accent_color: null,
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
      cover_url: row.coverUrl,
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
              cover_url: row.coverUrl,
              thumbhash: null,
              dominant_color: null,
              accent_color: null,
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

// POST /admin/sync/collecting
collecting.post('/admin/sync/collecting', requireAuth('admin'), async (c) => {
  try {
    await syncCollecting(c.env);
    return c.json({ status: 'ok', message: 'Collecting sync complete' });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] POST /admin/sync/collecting: ${errorMsg}`);
    return serverError(c, `Sync failed: ${errorMsg}`);
  }
});

export default collecting;
