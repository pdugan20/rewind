import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createDb, type Database } from '../db/client.js';
import { syncRuns } from '../db/schema/system.js';
import { setupTestDb } from '../test-helpers.js';
import { shouldRetry } from './sync-retry.js';

describe('shouldRetry', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(syncRuns);
  });

  it('returns shouldRetry=false when no sync runs exist', async () => {
    const result = await shouldRetry(db, 'listening');
    expect(result.shouldRetry).toBe(false);
    expect(result.consecutiveFailures).toBe(0);
  });

  it('returns shouldRetry=false when last run succeeded', async () => {
    await db.insert(syncRuns).values({
      domain: 'listening',
      syncType: 'scrobbles',
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      itemsSynced: 10,
    });

    const result = await shouldRetry(db, 'listening');
    expect(result.shouldRetry).toBe(false);
  });

  it('returns shouldRetry=true when last run failed (1 failure)', async () => {
    await db.insert(syncRuns).values({
      domain: 'running',
      syncType: 'incremental',
      status: 'failed',
      startedAt: new Date().toISOString(),
      error: 'API timeout',
    });

    const result = await shouldRetry(db, 'running');
    expect(result.shouldRetry).toBe(true);
    expect(result.consecutiveFailures).toBe(1);
  });

  it('returns shouldRetry=true when last 2 runs failed', async () => {
    const now = Date.now();
    await db.insert(syncRuns).values([
      {
        domain: 'watching',
        syncType: 'plex_library',
        status: 'failed',
        startedAt: new Date(now - 86400000).toISOString(),
        error: 'Plex unreachable',
      },
      {
        domain: 'watching',
        syncType: 'plex_library',
        status: 'failed',
        startedAt: new Date(now).toISOString(),
        error: 'Plex unreachable',
      },
    ]);

    const result = await shouldRetry(db, 'watching');
    expect(result.shouldRetry).toBe(true);
    expect(result.consecutiveFailures).toBe(2);
  });

  it('returns shouldRetry=false when 3+ consecutive failures (exceeds max)', async () => {
    const now = Date.now();
    await db.insert(syncRuns).values([
      {
        domain: 'collecting',
        syncType: 'discogs',
        status: 'failed',
        startedAt: new Date(now - 172800000).toISOString(),
        error: 'Rate limited',
      },
      {
        domain: 'collecting',
        syncType: 'discogs',
        status: 'failed',
        startedAt: new Date(now - 86400000).toISOString(),
        error: 'Rate limited',
      },
      {
        domain: 'collecting',
        syncType: 'discogs',
        status: 'failed',
        startedAt: new Date(now).toISOString(),
        error: 'Rate limited',
      },
    ]);

    const result = await shouldRetry(db, 'collecting');
    expect(result.shouldRetry).toBe(false);
    expect(result.consecutiveFailures).toBe(3);
  });

  it('resets after a successful run breaks the failure streak', async () => {
    const now = Date.now();
    await db.insert(syncRuns).values([
      {
        domain: 'listening',
        syncType: 'top_lists',
        status: 'failed',
        startedAt: new Date(now - 172800000).toISOString(),
        error: 'API error',
      },
      {
        domain: 'listening',
        syncType: 'top_lists',
        status: 'failed',
        startedAt: new Date(now - 86400000).toISOString(),
        error: 'API error',
      },
      {
        domain: 'listening',
        syncType: 'top_lists',
        status: 'completed',
        startedAt: new Date(now - 43200000).toISOString(),
        completedAt: new Date(now - 43000000).toISOString(),
        itemsSynced: 50,
      },
      {
        domain: 'listening',
        syncType: 'top_lists',
        status: 'failed',
        startedAt: new Date(now).toISOString(),
        error: 'API error again',
      },
    ]);

    const result = await shouldRetry(db, 'listening');
    expect(result.shouldRetry).toBe(true);
    expect(result.consecutiveFailures).toBe(1);
  });

  it('only considers runs for the specified domain', async () => {
    await db.insert(syncRuns).values([
      {
        domain: 'running',
        syncType: 'incremental',
        status: 'failed',
        startedAt: new Date().toISOString(),
        error: 'Strava down',
      },
      {
        domain: 'listening',
        syncType: 'scrobbles',
        status: 'completed',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        itemsSynced: 5,
      },
    ]);

    const listeningResult = await shouldRetry(db, 'listening');
    expect(listeningResult.shouldRetry).toBe(false);

    const runningResult = await shouldRetry(db, 'running');
    expect(runningResult.shouldRetry).toBe(true);
  });

  it('ignores running status (only checks completed/failed)', async () => {
    await db.insert(syncRuns).values({
      domain: 'watching',
      syncType: 'plex_library',
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    const result = await shouldRetry(db, 'watching');
    expect(result.shouldRetry).toBe(false);
  });
});
