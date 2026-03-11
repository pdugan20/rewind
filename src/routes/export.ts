import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../types/env.js';
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

const exportRoute = new Hono<{ Bindings: Env }>();

// GET /v1/export/:domain -- full domain data as JSON (admin only)
// Auth is enforced by the /v1/admin/* middleware in index.ts
exportRoute.get('/:domain', async (c) => {
  setCache(c, 'none');

  const domain = c.req.param('domain');
  if (!VALID_DOMAINS.includes(domain)) {
    return badRequest(
      c,
      `Invalid domain: ${domain}. Must be one of: ${VALID_DOMAINS.join(', ')}`
    );
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
