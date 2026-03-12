import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { setupTestDb } from '../test-helpers.js';

describe('OpenAPI spec endpoint', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  describe('GET /v1/openapi.json', () => {
    it('returns valid OpenAPI 3.1 spec', async () => {
      const res = await SELF.fetch('http://localhost/v1/openapi.json');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const spec = (await res.json()) as any;

      // OpenAPI version
      expect(spec.openapi).toBe('3.1.0');

      // Info block
      expect(spec.info.title).toBe('Rewind API');
      expect(spec.info.version).toBeDefined();

      // Servers
      expect(spec.servers).toBeInstanceOf(Array);
      expect(spec.servers.length).toBeGreaterThan(0);
      expect(spec.servers[0].url).toContain('rewind.rest');

      // Security scheme
      expect(spec.components?.securitySchemes?.bearerAuth).toBeDefined();
      expect(spec.components.securitySchemes.bearerAuth.type).toBe('http');
      expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    });

    it('does not require authentication', async () => {
      const res = await SELF.fetch('http://localhost/v1/openapi.json');
      expect(res.status).toBe(200);
    });

    it('includes paths from all route files', async () => {
      const res = await SELF.fetch('http://localhost/v1/openapi.json');
      const spec = (await res.json()) as any;
      const paths = Object.keys(spec.paths || {});

      // Spot-check paths from each domain
      expect(paths.some((p: string) => p.includes('/health'))).toBe(true);
      expect(paths.some((p: string) => p.includes('/listening'))).toBe(true);
      expect(paths.some((p: string) => p.includes('/running'))).toBe(true);
      expect(paths.some((p: string) => p.includes('/watching'))).toBe(true);
      expect(paths.some((p: string) => p.includes('/collecting'))).toBe(true);
      expect(paths.some((p: string) => p.includes('/feed'))).toBe(true);
    });

    it('has operations with tags, summaries, and responses', async () => {
      const res = await SELF.fetch('http://localhost/v1/openapi.json');
      const spec = (await res.json()) as any;

      // Check a known operation: GET /v1/health
      const healthPath = spec.paths['/v1/health'];
      expect(healthPath).toBeDefined();
      expect(healthPath.get).toBeDefined();
      expect(healthPath.get.tags).toBeInstanceOf(Array);
      expect(healthPath.get.summary).toBeTruthy();
      expect(healthPath.get.responses['200']).toBeDefined();
    });

    it('sets cache headers', async () => {
      const res = await SELF.fetch('http://localhost/v1/openapi.json');
      const cacheControl = res.headers.get('cache-control');
      expect(cacheControl).toContain('max-age=300');
    });
  });
});
