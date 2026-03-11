import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('API key management routes', () => {
  let adminToken: string;

  beforeAll(async () => {
    await setupTestDb();
    adminToken = await createTestApiKey({
      name: 'keys-admin',
      scope: 'admin',
    });
  });

  describe('POST /v1/admin/keys', () => {
    it('creates a new API key', async () => {
      const res = await SELF.fetch('http://localhost/v1/admin/keys', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'test-new-key', scope: 'read' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.key).toMatch(/^rw_/);
      expect(body.name).toBe('test-new-key');
      expect(body.scope).toBe('read');
      expect(body.key_prefix).toBeTruthy();
      expect(body.key_hint).toBeTruthy();
      expect(body.id).toBeTruthy();
    });

    it('creates admin key', async () => {
      const res = await SELF.fetch('http://localhost/v1/admin/keys', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'admin-key', scope: 'admin' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.scope).toBe('admin');
    });

    it('defaults to read scope', async () => {
      const res = await SELF.fetch('http://localhost/v1/admin/keys', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'default-scope-key' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.scope).toBe('read');
    });

    it('returns 400 without name', async () => {
      const res = await SELF.fetch('http://localhost/v1/admin/keys', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scope: 'read' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid scope', async () => {
      const res = await SELF.fetch('http://localhost/v1/admin/keys', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'bad-scope', scope: 'superadmin' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /v1/admin/keys', () => {
    it('lists all keys without exposing hashes', async () => {
      const res = await SELF.fetch('http://localhost/v1/admin/keys', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toBeTruthy();
      expect(body.data.length).toBeGreaterThanOrEqual(1);

      for (const key of body.data) {
        expect(key.key_hash).toBeUndefined();
        expect(key.key_prefix).toBeTruthy();
        expect(key.key_hint).toBeTruthy();
      }
    });
  });

  describe('DELETE /v1/admin/keys/:id', () => {
    it('revokes a key', async () => {
      const createRes = await SELF.fetch('http://localhost/v1/admin/keys', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'to-delete' }),
      });
      const { id } = (await createRes.json()) as any;

      const deleteRes = await SELF.fetch(
        `http://localhost/v1/admin/keys/${id}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(deleteRes.status).toBe(200);
      const body = (await deleteRes.json()) as any;
      expect(body.message).toBe('Key revoked');

      const listRes = await SELF.fetch('http://localhost/v1/admin/keys', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const listBody = (await listRes.json()) as any;
      const deletedKey = listBody.data.find((k: { id: number }) => k.id === id);
      expect(deletedKey.is_active).toBe(false);
    });

    it('returns 404 for non-existent key', async () => {
      const res = await SELF.fetch('http://localhost/v1/admin/keys/99999', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid ID', async () => {
      const res = await SELF.fetch('http://localhost/v1/admin/keys/abc', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(400);
    });
  });
});
