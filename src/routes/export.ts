import { createRoute, z } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses } from '../lib/schemas/common.js';
import { activityFeed, syncRuns } from '../db/schema/system.js';
import { badRequest } from '../lib/errors.js';
import { setCache } from '../lib/cache.js';

const VALID_DOMAINS = ['listening', 'running', 'watching', 'collecting'];

// Domain table names for raw SQL export
const DOMAIN_TABLES: Record<string, string[]> = {
  listening: [
    'lastfm_artists',
    'lastfm_albums',
    'lastfm_tracks',
    'lastfm_scrobbles',
    'lastfm_top_artists',
    'lastfm_top_albums',
    'lastfm_top_tracks',
    'lastfm_filters',
    'lastfm_user_stats',
  ],
  running: [
    'strava_activities',
    'strava_gear',
    'strava_personal_records',
    'strava_year_summaries',
    'strava_lifetime_stats',
    'strava_splits',
    'strava_tokens',
  ],
  watching: [
    'movies',
    'watch_history',
    'movie_genres',
    'movie_directors',
    'genres',
    'directors',
    'shows',
    'episodes',
  ],
  collecting: [
    'discogs_releases',
    'discogs_artists',
    'discogs_collection',
    'discogs_wantlist',
    'discogs_stats',
    'collection_listening_xref',
  ],
};

const exportRoute = createOpenAPIApp();

// ─── Schemas ────────────────────────────────────────────────────────

const DomainParam = z.object({
  domain: z
    .enum(['listening', 'running', 'watching', 'collecting'])
    .openapi({ example: 'listening' }),
});

const ExportResponse = z
  .object({
    domain: z.string().openapi({ example: 'listening' }),
    exported_at: z.string().datetime().openapi({ example: '2024-01-15T12:00:00.000Z' }),
    tables: z.record(z.string(), z.array(z.unknown())),
  })
  .openapi('ExportResponse');

// ─── Routes ─────────────────────────────────────────────────────────

const exportDomainRoute = createRoute({
  method: 'get',
  path: '/{domain}',
  tags: ['Admin'],
  summary: 'Export domain data',
  description:
    'Exports all data for a given domain as a downloadable JSON file. Includes all domain tables, activity feed entries, and sync runs.',
  request: {
    params: DomainParam,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ExportResponse } },
      description: 'Domain data export as downloadable JSON',
    },
    ...errorResponses(400, 401),
  },
});

// GET /v1/export/:domain -- full domain data as JSON (admin only)
// Auth is enforced by the /v1/admin/* middleware in index.ts
exportRoute.openapi(exportDomainRoute, async (c) => {
  setCache(c, 'none');

  const domain = c.req.valid('param').domain;
  if (!VALID_DOMAINS.includes(domain)) {
    return badRequest(
      c,
      `Invalid domain: ${domain}. Must be one of: ${VALID_DOMAINS.join(', ')}`
    ) as any;
  }

  const db = drizzle(c.env.DB);
  const tables = DOMAIN_TABLES[domain];

  const exportData: Record<string, unknown[]> = {};

  for (const table of tables) {
    try {
      const rows = await db.all(
        sql.raw(`SELECT * FROM ${table} WHERE user_id = 1`)
      );
      exportData[table] = rows;
    } catch {
      // Table may not exist yet if domain hasn't been set up
      exportData[table] = [];
    }
  }

  // Include activity feed entries for this domain
  const feedItems = await db
    .select()
    .from(activityFeed)
    .where(eq(activityFeed.domain, domain));
  exportData['activity_feed'] = feedItems;

  // Include sync runs for this domain
  const runs = await db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.domain, domain));
  exportData['sync_runs'] = runs;

  // Stream as JSON response
  const json = JSON.stringify(
    {
      domain,
      exported_at: new Date().toISOString(),
      tables: exportData,
    },
    null,
    2
  );

  return new Response(json, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${domain}-export-${new Date().toISOString().split('T')[0]}.json"`,
    },
  });
});

export default exportRoute;
