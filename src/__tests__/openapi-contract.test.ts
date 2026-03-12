import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Contract tests: verify actual API responses contain the fields
 * declared in the OpenAPI spec. One representative endpoint per domain.
 *
 * These catch cases where a handler returns a shape that doesn't match
 * the declared schema (e.g. missing data wrapper, wrong field names).
 */
describe('OpenAPI contract tests', () => {
  let readToken: string;
  let spec: any;

  beforeAll(async () => {
    await setupTestDb();
    readToken = await createTestApiKey({ name: 'contract-test', scope: 'read' });

    const specRes = await SELF.fetch('http://localhost/v1/openapi.json');
    spec = (await specRes.json()) as any;
  });

  function getResponseSchema(path: string, method: string, status = '200'): any {
    const pathObj = spec.paths[path];
    if (!pathObj) throw new Error(`Path ${path} not found in spec`);
    const op = pathObj[method];
    if (!op) throw new Error(`Method ${method} not found on ${path}`);
    const response = op.responses[status];
    if (!response) throw new Error(`Status ${status} not found on ${method} ${path}`);
    return response.content?.['application/json']?.schema;
  }

  function expectFieldsPresent(actual: any, schema: any, context: string) {
    if (!schema || !schema.properties) return;
    for (const key of Object.keys(schema.properties)) {
      if (schema.required && schema.required.includes(key)) {
        expect(actual, `${context}: missing required field "${key}"`).toHaveProperty(key);
      }
    }
  }

  // System
  it('GET /v1/health matches spec', async () => {
    const res = await SELF.fetch('http://localhost/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const schema = getResponseSchema('/v1/health', 'get');
    expectFieldsPresent(body, schema, 'GET /v1/health');
    expect(body.status).toBe('ok');
  });

  // Listening - stats returns flat object
  it('GET /v1/listening/stats matches spec shape', async () => {
    const res = await SELF.fetch('http://localhost/v1/listening/stats', {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty('total_scrobbles');
  });

  // Running
  it('GET /v1/running/stats matches spec shape', async () => {
    const res = await SELF.fetch('http://localhost/v1/running/stats', {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty('data');
  });

  // Watching
  it('GET /v1/watching/stats matches spec shape', async () => {
    const res = await SELF.fetch('http://localhost/v1/watching/stats', {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty('data');
  });

  // Collecting
  it('GET /v1/collecting/stats matches spec shape', async () => {
    const res = await SELF.fetch('http://localhost/v1/collecting/stats', {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty('data');
  });

  // Feed
  it('GET /v1/feed matches spec shape', async () => {
    const res = await SELF.fetch('http://localhost/v1/feed', {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('pagination');
  });

  // Error responses
  it('401 response matches error envelope', async () => {
    const res = await SELF.fetch('http://localhost/v1/listening/stats');
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty('error');
    expect(body).toHaveProperty('status', 401);
  });
});
