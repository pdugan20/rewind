import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { setupTestDb } from '../test-helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('OpenAPI spec snapshot', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  it('matches committed snapshot', async () => {
    const res = await SELF.fetch('http://localhost/v1/openapi.json');
    const spec = (await res.json()) as any;
    const json = JSON.stringify(spec, null, 2) + '\n';

    await expect(json).toMatchFileSnapshot('../../openapi.snapshot.json');
  });
});
