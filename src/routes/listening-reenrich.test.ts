import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createTestApiKey, setupTestDb } from '../test-helpers.js';

describe('POST /v1/listening/admin/reenrich-albums', () => {
  let read: string;
  let admin: string;
  beforeAll(async () => {
    await setupTestDb();
    read = await createTestApiKey({ name: 'reenrich-read', scope: 'read' });
    admin = await createTestApiKey({ name: 'reenrich-admin', scope: 'admin' });
  });
  const post = (token: string, body: unknown) =>
    SELF.fetch('http://localhost/v1/listening/admin/reenrich-albums', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  it('rejects a read key', async () => {
    const res = await post(read, { album_ids: [1] });
    expect([401, 403]).toContain(res.status);
  });

  it('defaults to a dry run and bounds the album list', async () => {
    const res = await post(admin, { album_ids: [999999] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      dry_run: true,
      truncated: false,
      items: [],
    });
    const tooMany = await post(admin, {
      album_ids: Array.from({ length: 21 }, (_, i) => i + 1),
    });
    expect(tooMany.status).toBe(400);
  });
});
