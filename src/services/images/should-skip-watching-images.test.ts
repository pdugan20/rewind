import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { setupTestDb } from '../../test-helpers.js';
import { syncRuns } from '../../db/schema/system.js';
import { shouldSkipWatchingImages } from './sync-images.js';

/**
 * Regression coverage for the Letterboxd-cron skip bug: shouldSkipWatchingImages
 * must dedup only against the Plex daily cron (syncType 'plex_library'), not the
 * Letterboxd sync's own domain='watching' completed run. A domain-only match
 * meant the Letterboxd cron always skipped poster fetching, leaving
 * Letterboxd-only movies without images until the next Plex cron.
 */
describe('shouldSkipWatchingImages', () => {
  beforeEach(async () => {
    await setupTestDb();
    await env.DB.exec('DELETE FROM sync_runs');
  });

  const db = () => drizzle(env.DB);

  async function insertRun(syncType: string, completedAt: string | null) {
    await db()
      .insert(syncRuns)
      .values({
        domain: 'watching',
        syncType,
        status: completedAt ? 'completed' : 'running',
        startedAt: completedAt ?? new Date().toISOString(),
        completedAt: completedAt ?? undefined,
      });
  }

  it('does not skip when only a recent Letterboxd run exists', async () => {
    await insertRun('letterboxd_rss', new Date().toISOString());
    expect(await shouldSkipWatchingImages(db())).toBe(false);
  });

  it('skips when a recent Plex run exists', async () => {
    await insertRun('plex_library', new Date().toISOString());
    expect(await shouldSkipWatchingImages(db())).toBe(true);
  });

  it('does not skip when the Plex run is older than the 6h window', async () => {
    const sevenHoursAgo = new Date(
      Date.now() - 7 * 60 * 60 * 1000
    ).toISOString();
    await insertRun('plex_library', sevenHoursAgo);
    expect(await shouldSkipWatchingImages(db())).toBe(false);
  });

  it('does not skip on a still-running (incomplete) Plex run', async () => {
    await insertRun('plex_library', null);
    expect(await shouldSkipWatchingImages(db())).toBe(false);
  });
});
