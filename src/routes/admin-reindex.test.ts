import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createDb } from '../db/client.js';
import { readingItems } from '../db/schema/reading.js';
import { setupTestDbWithFts5, createTestApiKey } from '../test-helpers.js';

describe('POST /v1/admin/reindex-search', () => {
  let adminToken: string;
  let readToken: string;

  beforeAll(async () => {
    await setupTestDbWithFts5();
    adminToken = await createTestApiKey({
      name: 'reindex-admin',
      scope: 'admin',
    });
    readToken = await createTestApiKey({
      name: 'reindex-read',
      scope: 'read',
    });
  });

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM search_index');
    try {
      await env.DB.exec('DELETE FROM reading_items');
    } catch {
      // table may not exist on some test runs
    }
  });

  it('rejects non-admin tokens', async () => {
    const res = await SELF.fetch('http://localhost/v1/admin/reindex-search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('reindexes reading items with description as subtitle', async () => {
    const db = createDb(env.DB);
    await db.insert(readingItems).values({
      userId: 1,
      source: 'instapaper',
      sourceId: 'test-1',
      title: "The Secret Weapon of 'S.N.L.'",
      description: 'A documentary about the writer Jim Downey.',
      status: 'unread',
      progress: 0,
      savedAt: '2026-04-01T00:00:00.000Z',
    });

    const res = await SELF.fetch('http://localhost/v1/admin/reindex-search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ domains: ['reading'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.domains.reading.indexed).toBe(1);

    // Verify the row is now searchable via the normalized match.
    const searchRes = await SELF.fetch(
      'http://localhost/v1/search?q=SNL+writer&domain=reading',
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    const searchBody = (await searchRes.json()) as any;
    expect(searchBody.data.length).toBe(1);
    expect(searchBody.data[0].title).toContain('snl');
  });

  it('defaults to all domains when body is empty', async () => {
    const res = await SELF.fetch('http://localhost/v1/admin/reindex-search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Object.keys(body.domains).sort()).toEqual(
      ['collecting', 'listening', 'reading', 'running', 'watching'].sort()
    );
  });
});
