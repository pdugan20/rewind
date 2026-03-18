import { createRoute, z } from '@hono/zod-openapi';
import { desc, eq, sql, and } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { createOpenAPIApp } from '../lib/openapi.js';
import { syncRuns } from '../db/schema/system.js';
import { setCache } from '../lib/cache.js';

const DOMAINS = ['listening', 'running', 'watching', 'collecting'];

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

const SyncHealthResponse = z
  .object({
    status: z.literal('ok'),
    domains: z.record(z.string(), SyncDomainStatus),
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
      content: { 'application/json': { schema: SyncHealthResponse } },
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

  for (const domain of DOMAINS) {
    const [latest] = await db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.domain, domain))
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
          sql`${syncRuns.startedAt} >= ${twentyFourHoursAgo}`
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

  return c.json({
    status: 'ok' as const,
    domains,
  });
});

export default system;
