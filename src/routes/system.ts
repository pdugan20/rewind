import { createRoute, z } from '@hono/zod-openapi';
import { desc, eq, sql, and, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { createOpenAPIApp } from '../lib/openapi.js';
import { syncRuns } from '../db/schema/system.js';
import {
  lastfmArtists,
  lastfmAlbums,
  lastfmTracks,
} from '../db/schema/lastfm.js';
import { setCache } from '../lib/cache.js';

const DOMAINS = [
  'listening',
  'running',
  'watching',
  'collecting',
  'reading',
  'attending',
];

const system = createOpenAPIApp();

// ─── Schemas ────────────────────────────────────────────────────────

const HealthResponse = z
  .object({
    status: z.literal('ok'),
    timestamp: z.string().datetime(),
  })
  .openapi('HealthResponse');

const SyncDomainStatus = z.object({
  last_sync: z.string().datetime().nullable(),
  status: z.string().openapi({ example: 'completed' }),
  sync_type: z.string().openapi({ example: 'scrobbles' }),
  items_synced: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  error: z.string().nullable(),
  error_rate: z.number().openapi({ example: 0.0 }),
});

const EnrichmentHealth = z.object({
  // Visible-bug watchdog: any artist the user actually listens to (>=5
  // plays) missing an Apple Music URL. Expect this to stay in low single
  // digits — growth indicates the enrichment pipeline is degrading.
  artists_missing_apple_music_url_with_plays: z.number().int(),
  // Full-coverage counter for trend monitoring.
  artists_missing_apple_music_url: z.number().int(),
  // Track-enrichment backlog. Expect to stay near 0; the daily cron drains it.
  tracks_missing_itunes_enrichment: z.number().int(),
});

const IntegrityHealth = z.object({
  // Tracks pointing at an album whose artist_id != the track's artist_id —
  // the cross-artist attribution bug from migration 0018. Phase 1 stops new
  // corruption; Phase 3 drives this to 0. See
  // docs/projects/album-attribution-repair/README.md.
  lastfm_album_artist_mismatch_count: z.number().int(),
});

const SyncHealthResponse = z
  .object({
    status: z.literal('ok'),
    domains: z.record(z.string(), SyncDomainStatus),
    enrichment: EnrichmentHealth,
    integrity: IntegrityHealth,
  })
  .openapi('SyncHealthResponse');

// ─── Routes ─────────────────────────────────────────────────────────

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  operationId: 'getHealth',
  tags: ['System'],
  summary: 'Health check',
  description: 'Returns API health status and current timestamp.',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: HealthResponse,
          example: {
            status: 'ok',
            timestamp: '2026-03-18T21:00:00.000Z',
          },
        },
      },
      description: 'API is healthy',
    },
  },
});

system.openapi(healthRoute, (c) => {
  setCache(c, 'realtime');
  return c.json({
    status: 'ok' as const,
    timestamp: new Date().toISOString(),
  });
});

const syncHealthRoute = createRoute({
  method: 'get',
  path: '/health/sync',
  operationId: 'getHealthSync',
  tags: ['System'],
  summary: 'Sync health status',
  description:
    'Returns the latest sync status for each data domain, including last sync time, items synced, duration, and 24-hour error rate.',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: SyncHealthResponse,
          example: {
            status: 'ok',
            domains: {
              listening: {
                last_sync: '2026-03-18T21:00:00.000Z',
                status: 'completed',
                sync_type: 'scrobbles',
                items_synced: 42,
                duration_ms: 1250,
                error: null,
                error_rate: 0.0,
              },
              running: {
                last_sync: '2026-03-18T03:00:00.000Z',
                status: 'completed',
                sync_type: 'activities',
                items_synced: 3,
                duration_ms: 4200,
                error: null,
                error_rate: 0.0,
              },
            },
            enrichment: {
              artists_missing_apple_music_url_with_plays: 0,
              artists_missing_apple_music_url: 0,
              tracks_missing_itunes_enrichment: 0,
            },
            integrity: {
              lastfm_album_artist_mismatch_count: 0,
            },
          },
        },
      },
      description: 'Sync status for all domains',
    },
  },
});

system.openapi(syncHealthRoute, async (c) => {
  setCache(c, 'short');

  const db = drizzle(c.env.DB);

  const domains: Record<
    string,
    {
      last_sync: string | null;
      status: string;
      sync_type: string;
      items_synced: number | null;
      duration_ms: number | null;
      error: string | null;
      error_rate: number;
    }
  > = {};

  // Some sync_runs rows are metadata storage (e.g., the attending
  // domain's calendar_sync_token persistence) — skip those when
  // surfacing sync health, since they always have status='completed'
  // and would mask real sync runs.
  const METADATA_SYNC_TYPES = ['calendar_sync_token'];

  for (const domain of DOMAINS) {
    const [latest] = await db
      .select()
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.domain, domain),
          sql`${syncRuns.syncType} NOT IN (${sql.join(
            METADATA_SYNC_TYPES.map((t) => sql`${t}`),
            sql`, `
          )})`
        )
      )
      .orderBy(desc(syncRuns.startedAt))
      .limit(1);

    const twentyFourHoursAgo = new Date(
      Date.now() - 24 * 60 * 60 * 1000
    ).toISOString();

    const [stats] = await db
      .select({
        total: sql<number>`count(*)`,
        failed: sql<number>`sum(case when ${syncRuns.status} = 'failed' then 1 else 0 end)`,
      })
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.domain, domain),
          sql`${syncRuns.startedAt} >= ${twentyFourHoursAgo}`,
          sql`${syncRuns.syncType} NOT IN (${sql.join(
            METADATA_SYNC_TYPES.map((t) => sql`${t}`),
            sql`, `
          )})`
        )
      );

    let durationMs: number | null = null;
    if (latest?.startedAt && latest?.completedAt) {
      durationMs =
        new Date(latest.completedAt).getTime() -
        new Date(latest.startedAt).getTime();
    }

    const total = stats?.total ?? 0;
    const failed = stats?.failed ?? 0;
    const errorRate = total > 0 ? failed / total : 0;

    domains[domain] = {
      last_sync: latest?.completedAt ?? latest?.startedAt ?? null,
      status: latest?.status ?? 'never',
      sync_type: latest?.syncType ?? 'unknown',
      items_synced: latest?.itemsSynced ?? null,
      duration_ms: durationMs,
      error: latest?.status === 'failed' ? (latest?.error ?? null) : null,
      error_rate: Math.round(errorRate * 100) / 100,
    };
  }

  // Enrichment-pipeline health counters. Added in the apple-music-enrichment
  // project so a silent regression in track or artist URL coverage is
  // visible without manual SQL.
  const [enrichmentRow] = await db
    .select({
      artistsMissingWithPlays: sql<number>`sum(case when ${lastfmArtists.appleMusicUrl} is null and ${lastfmArtists.isFiltered} = 0 and ${lastfmArtists.playcount} >= 5 then 1 else 0 end)`,
      artistsMissing: sql<number>`sum(case when ${lastfmArtists.appleMusicUrl} is null and ${lastfmArtists.isFiltered} = 0 then 1 else 0 end)`,
    })
    .from(lastfmArtists);

  const [trackRow] = await db
    .select({
      tracksMissing: sql<number>`count(*)`,
    })
    .from(lastfmTracks)
    .where(
      and(isNull(lastfmTracks.itunesEnrichedAt), eq(lastfmTracks.isFiltered, 0))
    );

  // Data-integrity counter: tracks pointing at an album whose artist
  // doesn't match. Drops to 0 once the album-attribution-repair project
  // Phase 3 runs; before then, expect ~1,541 (2026-05-28 baseline).
  const [integrityRow] = await db
    .select({
      mismatchCount: sql<number>`count(*)`,
    })
    .from(lastfmTracks)
    .innerJoin(lastfmAlbums, eq(lastfmTracks.albumId, lastfmAlbums.id))
    .where(sql`${lastfmTracks.artistId} != ${lastfmAlbums.artistId}`);

  return c.json({
    status: 'ok' as const,
    domains,
    enrichment: {
      artists_missing_apple_music_url_with_plays:
        enrichmentRow?.artistsMissingWithPlays ?? 0,
      artists_missing_apple_music_url: enrichmentRow?.artistsMissing ?? 0,
      tracks_missing_itunes_enrichment: trackRow?.tracksMissing ?? 0,
    },
    integrity: {
      lastfm_album_artist_mismatch_count: integrityRow?.mismatchCount ?? 0,
    },
  });
});

export default system;
