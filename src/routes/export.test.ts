import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { activityFeed } from '../db/schema/system.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('export routes', () => {
  let adminToken: string;
  let readToken: string;

  beforeAll(async () => {
    await setupTestDb();
    adminToken = await createTestApiKey({
      name: 'export-admin',
      scope: 'admin',
    });
    readToken = await createTestApiKey({
      name: 'export-read',
      scope: 'read',
    });
  });

  describe('GET /v1/admin/export/:domain', () => {
    it('returns domain export JSON', async () => {
      const db = drizzle(env.DB);
      await db.insert(activityFeed).values({
        userId: 1,
        domain: 'listening',
        eventType: 'scrobble',
        occurredAt: '2024-01-01T00:00:00Z',
        title: 'Test Song',
        sourceId: 'export-test-1',
        createdAt: new Date().toISOString(),
      });

      const res = await SELF.fetch(
        'http://localhost/v1/admin/export/listening',
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.domain).toBe('listening');
      expect(body.exported_at).toBeTruthy();
      expect(body.tables).toBeTruthy();
      expect(body.tables.activity_feed).toBeTruthy();
      expect(body.tables.activity_feed.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 400 for invalid domain', async () => {
      const res = await SELF.fetch('http://localhost/v1/admin/export/invalid', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(400);
    });

    it('requires admin auth', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/admin/export/listening',
        { headers: { Authorization: `Bearer ${readToken}` } }
      );
      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated requests', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/admin/export/listening'
      );
      expect(res.status).toBe(401);
    });

    it('includes Content-Disposition header for download', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/admin/export/listening',
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      const contentDisp = res.headers.get('Content-Disposition');
      expect(contentDisp).toContain('attachment');
      expect(contentDisp).toContain('listening-export');
    });
  });
});
