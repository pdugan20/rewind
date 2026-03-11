import { Hono } from 'hono';
import { desc, eq, sql, and } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../types/env.js';
import { syncRuns } from '../db/schema/system.js';
import { setCache } from '../lib/cache.js';

const DOMAINS = ['listening', 'running', 'watching', 'collecting'];

const system = new Hono<{ Bindings: Env }>();

system.get('/health', (c) => {
  setCache(c, 'realtime');
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

system.get('/health/sync', async (c) => {
  setCache(c, 'short');

  const db = drizzle(c.env.DB);

  // Get the latest sync run for each domain
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
    // Latest sync run
    const [latest] = await db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.domain, domain))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1);

    // Error rate: count failed vs total in last 24 hours
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
    status: 'ok',
    domains,
  });
});

export default system;
