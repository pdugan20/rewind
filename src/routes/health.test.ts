import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { syncRuns } from '../db/schema/system.js';
import { setupTestDb } from '../test-helpers.js';

describe('health/sync endpoint', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  describe('GET /v1/health', () => {
    it('returns ok status', async () => {
      const res = await SELF.fetch('http://localhost/v1/health');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeTruthy();
    });
  });

  describe('GET /v1/health/sync', () => {
    it('returns sync status for all domains', async () => {
      const res = await SELF.fetch('http://localhost/v1/health/sync');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.status).toBe('ok');
      expect(body.domains).toBeTruthy();
      expect(body.domains.listening).toBeTruthy();
      expect(body.domains.running).toBeTruthy();
      expect(body.domains.watching).toBeTruthy();
      expect(body.domains.collecting).toBeTruthy();
    });

    it('shows "never" for domains with no sync runs', async () => {
      const res = await SELF.fetch('http://localhost/v1/health/sync');
      const body = (await res.json()) as any;
      expect(body.domains.collecting.status).toBe('never');
      expect(body.domains.collecting.last_sync).toBeNull();
    });

    it('shows sync details after a sync run', async () => {
      const db = drizzle(env.DB);
      const startedAt = new Date(Date.now() - 5000).toISOString();
      const completedAt = new Date().toISOString();

      await db.insert(syncRuns).values({
        userId: 1,
        domain: 'watching',
        syncType: 'library-scan',
        status: 'completed',
        startedAt,
        completedAt,
        itemsSynced: 42,
      });

      const res = await SELF.fetch('http://localhost/v1/health/sync');
      const body = (await res.json()) as any;
      expect(body.domains.watching.status).toBe('completed');
      expect(body.domains.watching.items_synced).toBe(42);
      expect(body.domains.watching.duration_ms).toBeGreaterThan(0);
      expect(body.domains.watching.error).toBeNull();
    });

    it('tracks error rate', async () => {
      const db = drizzle(env.DB);
      const now = Date.now();

      await db.insert(syncRuns).values({
        userId: 1,
        domain: 'running',
        syncType: 'activities',
        status: 'failed',
        startedAt: new Date(now - 3600000).toISOString(),
        error: 'API timeout',
      });
      await db.insert(syncRuns).values({
        userId: 1,
        domain: 'running',
        syncType: 'activities',
        status: 'completed',
        startedAt: new Date(now - 1800000).toISOString(),
        completedAt: new Date(now - 1700000).toISOString(),
        itemsSynced: 10,
      });

      const res = await SELF.fetch('http://localhost/v1/health/sync');
      const body = (await res.json()) as any;
      expect(body.domains.running.error_rate).toBeGreaterThan(0);
      expect(body.domains.running.error_rate).toBeLessThanOrEqual(1);
    });
  });
});
