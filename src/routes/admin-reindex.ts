/**
 * POST /v1/admin/reindex-search -- rebuild the FTS search_index from source tables.
 *
 * After migration 0026 drops + recreates the FTS table with a new schema,
 * this endpoint repopulates it. Safe to re-run at any time.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses } from '../lib/schemas/common.js';
import { createDb } from '../db/client.js';
import { eq, sql } from 'drizzle-orm';
import { upsertSearchIndexBatch, type SearchIndexItem } from './search.js';
import { readingItems } from '../db/schema/reading.js';
import { movies } from '../db/schema/watching.js';
import {
  lastfmArtists,
  lastfmAlbums,
  lastfmTracks,
} from '../db/schema/lastfm.js';
import { stravaActivities } from '../db/schema/strava.js';
import {
  discogsCollection,
  discogsReleases,
  discogsReleaseArtists,
  discogsArtists,
} from '../db/schema/discogs.js';

const ALL_DOMAINS = [
  'reading',
  'watching',
  'listening',
  'running',
  'collecting',
] as const;
type Domain = (typeof ALL_DOMAINS)[number];

const adminReindex = createOpenAPIApp();

const DomainResultSchema = z.object({
  indexed: z.number(),
  took_ms: z.number(),
  error: z.string().optional(),
});

const ReindexResponseSchema = z.object({
  domains: z.record(z.string(), DomainResultSchema),
});

const ReindexBodySchema = z
  .object({
    domains: z.array(z.enum(ALL_DOMAINS)).optional(),
  })
  .optional();

const reindexRoute = createRoute({
  method: 'post',
  path: '/reindex-search',
  operationId: 'reindexSearch',
  tags: ['Admin'],
  summary: 'Rebuild the FTS search_index',
  description:
    'Truncates and repopulates the search_index FTS table from source tables. Pass `domains` in the body to limit scope; default rebuilds all five domains.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: ReindexBodySchema,
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      description: 'Reindex complete',
      content: {
        'application/json': {
          schema: ReindexResponseSchema,
        },
      },
    },
    ...errorResponses(401),
  },
});

adminReindex.openapi(reindexRoute, async (c) => {
  const db = createDb(c.env.DB);
  const body = (await c.req.json().catch(() => undefined)) as
    | { domains?: Domain[] }
    | undefined;
  const selected: readonly Domain[] =
    body?.domains && body.domains.length > 0 ? body.domains : ALL_DOMAINS;

  const results: Record<string, z.infer<typeof DomainResultSchema>> = {};

  for (const domain of selected) {
    const t0 = Date.now();
    try {
      // Clear existing rows for this domain before inserting
      await db.run(sql`DELETE FROM search_index WHERE domain = ${domain}`);

      const items = await buildSearchItemsForDomain(db, domain);
      await upsertSearchIndexBatch(db, items);
      results[domain] = { indexed: items.length, took_ms: Date.now() - t0 };
    } catch (error) {
      results[domain] = {
        indexed: 0,
        took_ms: Date.now() - t0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return c.json({ domains: results });
});

async function buildSearchItemsForDomain(
  db: ReturnType<typeof createDb>,
  domain: Domain
): Promise<SearchIndexItem[]> {
  switch (domain) {
    case 'reading':
      return buildReading(db);
    case 'watching':
      return buildWatching(db);
    case 'listening':
      return buildListening(db);
    case 'running':
      return buildRunning(db);
    case 'collecting':
      return buildCollecting(db);
  }
}

async function buildReading(
  db: ReturnType<typeof createDb>
): Promise<SearchIndexItem[]> {
  const rows = await db
    .select({
      id: readingItems.id,
      title: readingItems.title,
      description: readingItems.description,
    })
    .from(readingItems)
    .where(eq(readingItems.userId, 1));

  return rows.map((r) => ({
    domain: 'reading',
    entityType: 'article',
    entityId: String(r.id),
    title: r.title,
    subtitle: r.description ?? undefined,
  }));
}

async function buildWatching(
  db: ReturnType<typeof createDb>
): Promise<SearchIndexItem[]> {
  const rows = await db
    .select({
      id: movies.id,
      title: movies.title,
      year: movies.year,
    })
    .from(movies)
    .where(eq(movies.userId, 1));

  return rows.map((m) => ({
    domain: 'watching',
    entityType: 'movie',
    entityId: String(m.id),
    title: m.title,
    subtitle: m.year ? String(m.year) : undefined,
  }));
}

async function buildListening(
  db: ReturnType<typeof createDb>
): Promise<SearchIndexItem[]> {
  const items: SearchIndexItem[] = [];

  const artists = await db
    .select({ id: lastfmArtists.id, name: lastfmArtists.name })
    .from(lastfmArtists)
    .where(eq(lastfmArtists.userId, 1));
  const artistNameById = new Map<number, string>();
  for (const a of artists) {
    artistNameById.set(a.id, a.name);
    items.push({
      domain: 'listening',
      entityType: 'artist',
      entityId: String(a.id),
      title: a.name,
    });
  }

  const albums = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      artistId: lastfmAlbums.artistId,
    })
    .from(lastfmAlbums)
    .where(eq(lastfmAlbums.userId, 1));
  for (const al of albums) {
    items.push({
      domain: 'listening',
      entityType: 'album',
      entityId: String(al.id),
      title: al.name,
      subtitle: artistNameById.get(al.artistId),
    });
  }

  const tracks = await db
    .select({
      id: lastfmTracks.id,
      name: lastfmTracks.name,
      artistId: lastfmTracks.artistId,
    })
    .from(lastfmTracks)
    .where(eq(lastfmTracks.userId, 1));
  for (const t of tracks) {
    items.push({
      domain: 'listening',
      entityType: 'track',
      entityId: String(t.id),
      title: t.name,
      subtitle: artistNameById.get(t.artistId),
    });
  }

  return items;
}

async function buildRunning(
  db: ReturnType<typeof createDb>
): Promise<SearchIndexItem[]> {
  const rows = await db
    .select({
      id: stravaActivities.id,
      name: stravaActivities.name,
      city: stravaActivities.city,
    })
    .from(stravaActivities)
    .where(eq(stravaActivities.userId, 1));

  return rows.map((a) => ({
    domain: 'running',
    entityType: 'activity',
    entityId: String(a.id),
    title: a.name ?? 'Run',
    subtitle: a.city ?? undefined,
  }));
}

async function buildCollecting(
  db: ReturnType<typeof createDb>
): Promise<SearchIndexItem[]> {
  // Build artist subtitle by joining release -> release_artists -> artists.
  // A release can have multiple artists; we just take the first for subtitle.
  const rows = await db
    .select({
      releaseId: discogsCollection.releaseId,
      title: discogsReleases.title,
    })
    .from(discogsCollection)
    .innerJoin(
      discogsReleases,
      eq(discogsCollection.releaseId, discogsReleases.id)
    )
    .where(eq(discogsCollection.userId, 1));

  const artistJoin = await db
    .select({
      releaseId: discogsReleaseArtists.releaseId,
      artistName: discogsArtists.name,
    })
    .from(discogsReleaseArtists)
    .innerJoin(
      discogsArtists,
      eq(discogsReleaseArtists.artistId, discogsArtists.id)
    );
  const firstArtistByRelease = new Map<number, string>();
  for (const row of artistJoin) {
    if (!firstArtistByRelease.has(row.releaseId)) {
      firstArtistByRelease.set(row.releaseId, row.artistName);
    }
  }

  return rows.map((r) => ({
    domain: 'collecting',
    entityType: 'release',
    entityId: String(r.releaseId),
    title: r.title ?? 'Untitled',
    subtitle: firstArtistByRelease.get(r.releaseId),
  }));
}

export default adminReindex;
